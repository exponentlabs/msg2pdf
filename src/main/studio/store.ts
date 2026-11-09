import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  statfs,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  evidenceHash,
  releaseGate,
  type StudioState,
  studioStateSchema,
} from '../../core/studio/domain';
import { assertLegacyDestination } from '../../core/studio/paths';

export interface CaseLock {
  acquire(path: string): number;
  guard(root: string): number;
  promoteDirectory(source: string, target: string): void;
}
export function nativeCaseLock(binary: string): CaseLock {
  const value: unknown = createRequire(resolve(binary))(resolve(binary));
  if (
    !value ||
    typeof value !== 'object' ||
    !('acquire' in value) ||
    typeof value.acquire !== 'function' ||
    !('guard' in value) ||
    typeof value.guard !== 'function' ||
    !('promoteDirectory' in value) ||
    typeof value.promoteDirectory !== 'function'
  )
    throw new Error('CASE_LOCK_UNAVAILABLE');
  return value as CaseLock;
}
const artifactSchema = z
  .object({
    path: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    documentId: z.string().uuid(),
    role: z.enum(['source', 'revision', 'snapshot', 'candidate', 'evidence', 'release']),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;
const operationSchema = z
  .object({
    expectedVersion: z.number().int(),
    nextState: studioStateSchema,
    artifacts: z.array(artifactSchema),
    package: z
      .object({ path: z.string(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    source: z
      .object({ documentId: z.string().uuid(), originalName: z.string(), origin: z.string() })
      .optional(),
    sources: z
      .array(
        z
          .object({ documentId: z.string().uuid(), originalName: z.string(), origin: z.string() })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();
type Operation = z.infer<typeof operationSchema>;
const markerSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid() }).strict();
const roots = ['Exported', 'For Redaction', 'Redacted for sharing', '.studio'] as const;
function acquireCaseLock(binding: CaseLock, root: string): number[] {
  const directory = binding.guard(root);
  try {
    return [directory, binding.acquire(join(root, '.studio/locks/case.lock'))];
  } catch (error) {
    closeSync(directory);
    throw error;
  }
}
export function bytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CASE_INTEGRITY_ERROR');
  await chmod(path, 0o700);
}
async function emptyPrivateDirectory(path: string): Promise<void> {
  await assertLegacyDestination(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('CASE_INTEGRITY_ERROR');
  if ((await readdir(path)).length) throw new Error('Choose an empty working folder');
  await localFilesystem(path);
  await chmod(path, 0o700);
}
async function localFilesystem(path: string): Promise<void> {
  const info = await statfs(path);
  // Native Linux filesystems only. tmpfs is useful for ephemeral synthetic cases,
  // and has the same process-termination boundary, with no reboot persistence.
  if (![0x9123683e, 0xef53, 0x58465342, 0x01021994].includes(info.type >>> 0))
    throw new Error('Use a local Btrfs, ext4, XFS or ephemeral tmpfs working folder.');
}

export class CaseStore {
  /** Internal boundary observer supports process-interruption verification; never exposed over IPC. */
  observer: ((boundary: string) => void) | undefined;
  private busy = false;
  private closed = false;
  private constructor(
    readonly root: string,
    private readonly db: DatabaseSync,
    private readonly lock: number[],
    private readonly binding: CaseLock,
  ) {}
  static async create(
    root: string,
    lock: CaseLock,
    policyHash: string,
    contractHash: string,
  ): Promise<CaseStore> {
    const absolute = resolve(root);
    await emptyPrivateDirectory(absolute);
    await mkdir(join(absolute, '.studio'), { mode: 0o700 });
    for (const directory of roots) await privateDirectory(join(absolute, directory));
    for (const directory of ['locks', 'staging', 'candidates', 'snapshots'])
      await privateDirectory(join(absolute, '.studio', directory));
    const descriptor = acquireCaseLock(lock, absolute);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(absolute, '.studio/case.sqlite'));
      db.exec(
        'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE state(version INTEGER NOT NULL, json TEXT NOT NULL); CREATE TABLE artifacts(path TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY, stage TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE events(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL); CREATE TABLE sources(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=1;',
      );
      const state = studioStateSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        version: 0,
        policyHash,
        contractHash,
        documents: [],
        families: [],
      });
      db.prepare('INSERT INTO state VALUES(?, ?)').run(0, JSON.stringify(state));
      db.exec('COMMIT');
      await chmod(join(absolute, '.studio/case.sqlite'), 0o600);
      const marker = await open(join(absolute, '.studio/case.json'), 'wx', 0o600);
      try {
        await marker.writeFile(JSON.stringify({ schemaVersion: 1, id: state.id }));
        await marker.sync();
      } finally {
        await marker.close();
      }
      await syncDirectory(join(absolute, '.studio'));
      await syncDirectory(absolute);
      return new CaseStore(await realpath(absolute), db, descriptor, lock);
    } catch (error) {
      db?.close();
      descriptor.forEach(closeSync);
      throw error;
    }
  }
  static async open(root: string, lock: CaseLock): Promise<CaseStore> {
    const absolute = await realpath(root);
    await localFilesystem(absolute);
    for (const directory of [
      absolute,
      join(absolute, '.studio'),
      join(absolute, '.studio/locks'),
    ]) {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.mode & 0o077
      )
        throw new Error('CASE_INTEGRITY_ERROR');
    }
    const descriptor = acquireCaseLock(lock, absolute);
    let db: DatabaseSync | undefined;
    try {
      const markerInfo = await lstat(join(absolute, '.studio/case.json'));
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1)
        throw new Error('CASE_INTEGRITY_ERROR');
      const marker = markerSchema.parse(
        JSON.parse(await readFile(join(absolute, '.studio/case.json'), 'utf8')),
      );
      const info = await lstat(join(absolute, '.studio/case.sqlite'));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error('CASE_INTEGRITY_ERROR');
      db = new DatabaseSync(join(absolute, '.studio/case.sqlite'));
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
        throw new Error('Unsupported case schema');
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      if (
        db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' ||
        db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      )
        throw new Error('CASE_INTEGRITY_ERROR');
      const store = new CaseStore(absolute, db, descriptor, lock);
      if (store.state().id !== marker.id) throw new Error('CASE_INTEGRITY_ERROR');
      await store.recover();
      await store.validate();
      return store;
    } catch (error) {
      db?.close();
      descriptor.forEach(closeSync);
      throw error;
    }
  }
  state(): StudioState {
    if (this.closed) throw new Error('Case is closed');
    const row = this.db.prepare('SELECT version, json FROM state').get();
    if (!row || typeof row.json !== 'string') throw new Error('CASE_INTEGRITY_ERROR');
    const state = studioStateSchema.parse(JSON.parse(row.json));
    if (state.version !== row.version) throw new Error('CASE_INTEGRITY_ERROR');
    return state;
  }
  artifacts(): Artifact[] {
    return this.db
      .prepare('SELECT json FROM artifacts ORDER BY path')
      .all()
      .map((row) => artifactSchema.parse(JSON.parse(String(row.json))));
  }
  source(documentId: string): { originalName: string; origin: string } {
    const row = this.db.prepare('SELECT json FROM sources WHERE id=?').get(documentId);
    if (!row) throw new Error('Unknown source');
    return z
      .object({ documentId: z.string(), originalName: z.string(), origin: z.string() })
      .parse(JSON.parse(String(row.json)));
  }
  async path(path: string, create = false): Promise<string> {
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !roots.some((root) => path.startsWith(`${root}/`))
    )
      throw new Error('CASE_INTEGRITY_ERROR');
    let current = this.root;
    for (const [index, part] of path.split('/').entries()) {
      current = join(current, part);
      if (index < path.split('/').length - 1 && create)
        await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < path.split('/').length - 1 && !info.isDirectory()))
          throw new Error('CASE_INTEGRITY_ERROR');
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (!relative(this.root, current) || relative(this.root, current).startsWith(`..${sep}`))
      throw new Error('CASE_INTEGRITY_ERROR');
    return current;
  }
  private finish(id: string, operation: Operation): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = studioStateSchema.parse(operation.nextState);
      const result = this.db
        .prepare('UPDATE state SET version=?,json=? WHERE version=?')
        .run(next.version, JSON.stringify(next), operation.expectedVersion);
      if (Number(result.changes) !== 1 || next.version !== operation.expectedVersion + 1)
        throw new Error('STATE_STALE');
      for (const artifact of operation.artifacts)
        this.db
          .prepare('INSERT INTO artifacts VALUES(?,?)')
          .run(artifact.path, JSON.stringify(artifact));
      if (operation.source)
        this.db
          .prepare('INSERT INTO sources VALUES(?,?)')
          .run(operation.source.documentId, JSON.stringify(operation.source));
      for (const source of operation.sources ?? [])
        this.db
          .prepare('INSERT INTO sources VALUES(?,?)')
          .run(source.documentId, JSON.stringify(source));
      this.db.prepare('UPDATE operations SET stage=? WHERE id=?').run('complete', id);
      this.db
        .prepare('INSERT INTO events(kind,version,digest) VALUES(?,?,?)')
        .run(
          'transition',
          next.version,
          evidenceHash({ id, artifacts: operation.artifacts.map((artifact) => artifact.hash) }),
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async transition(
    expectedVersion: number,
    nextState: StudioState,
    outputs: { artifact: Omit<Artifact, 'hash' | 'size'>; bytes: Uint8Array }[] = [],
    source?: Operation['source'],
    sources?: Operation['sources'],
  ): Promise<StudioState> {
    if (this.busy) throw new Error('CASE_BUSY');
    this.busy = true;
    const id = randomUUID();
    try {
      if (this.state().version !== expectedVersion) throw new Error('STATE_STALE');
      if (
        this.db
          .prepare("SELECT id FROM operations WHERE stage NOT IN ('complete','aborted') LIMIT 1")
          .get()
      )
        throw new Error('CASE_INTEGRITY_ERROR');
      await this.validate();
      const disk = await statfs(this.root);
      const required = outputs.reduce((sum, output) => sum + output.bytes.byteLength, 0);
      if (disk.bavail * disk.bsize < required + 64 * 1024 * 1024)
        throw new Error('Insufficient case disk space');
      const operation = operationSchema.parse({
        expectedVersion,
        nextState: { ...nextState, version: expectedVersion + 1 },
        artifacts: outputs.map(({ artifact, bytes }) => ({
          ...artifact,
          hash: bytesHash(bytes),
          size: bytes.byteLength,
        })),
        ...(source ? { source } : {}),
        ...(sources ? { sources } : {}),
      });
      if (Buffer.byteLength(JSON.stringify(operation.nextState)) > 32 * 1024 * 1024)
        throw new Error('Case metadata budget exceeded');
      if (
        required > 256 * 1024 * 1024 ||
        outputs.some((output) => output.bytes.byteLength > 100 * 1024 * 1024)
      )
        throw new Error('Artifact budget exceeded');
      for (const artifact of operation.artifacts) {
        if (artifact.role === 'release' || artifact.path.startsWith('Redacted for sharing/'))
          throw new Error('Publication requires atomic package promotion');
        const prefix =
          artifact.role === 'source'
            ? 'Exported/'
            : artifact.role === 'revision'
              ? 'For Redaction/'
              : '.studio/';
        if (
          !artifact.path.startsWith(prefix) ||
          !artifact.path.includes(`/${artifact.documentId}/`) ||
          !operation.nextState.documents.some((document) => document.id === artifact.documentId)
        )
          throw new Error('CASE_INTEGRITY_ERROR');
        await this.path(artifact.path, true);
        if (this.artifacts().some((existing) => existing.path === artifact.path))
          throw new Error('Immutable artifact already exists');
      }
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?)')
        .run(id, 'intent', JSON.stringify(operation));
      this.observer?.('intent');
      const staging = join(this.root, '.studio/staging', id);
      await privateDirectory(staging);
      for (const [index, output] of outputs.entries()) {
        const handle = await open(join(staging, String(index)), 'wx', 0o600);
        try {
          await handle.writeFile(output.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(staging);
      this.db.prepare('UPDATE operations SET stage=? WHERE id=?').run('prepared', id);
      this.observer?.('prepared');
      for (const [index, artifact] of operation.artifacts.entries()) {
        const target = await this.path(artifact.path, true);
        await link(join(staging, String(index)), target);
        await unlink(join(staging, String(index)));
        await syncDirectory(dirname(target));
        this.observer?.('promoted');
      }
      this.finish(id, operation);
      this.observer?.('committed');
      await rm(staging, { recursive: true });
      return this.state();
    } finally {
      this.busy = false;
    }
  }
  async capture(
    input: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<StudioState> {
    const canonical = await realpath(input);
    if (canonical === this.root || canonical.startsWith(`${this.root}${sep}`))
      throw new Error('Recursive case intake is forbidden');
    const handle = await open(
      input,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 100 * 1024 * 1024) throw new Error('Invalid source');
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, 100 * 1024 * 1024 - total + 1));
        const read = await handle.read(chunk, 0, chunk.length, null);
        if (!read.bytesRead) break;
        total += read.bytesRead;
        if (total > 100 * 1024 * 1024) throw new Error('Source budget exceeded');
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      bytes = Buffer.concat(chunks, total);
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        throw new Error('SOURCE_CHANGED');
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    const state = this.state();
    const id = randomUUID();
    const extension = extname(input).slice(1).toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(extension)) throw new Error('Unsupported source name');
    state.documents.push({ id, sourceHash: bytesHash(bytes) });
    return this.transition(
      expectedVersion,
      state,
      [
        {
          artifact: {
            path: `Exported/${randomUUID()}/${id}/source.${extension}`,
            documentId: id,
            role: 'source',
          },
          bytes,
        },
      ],
      { documentId: id, originalName: basename(input), origin: canonical },
    );
  }
  private checkPublication(operation: Operation): void {
    const state = this.state();
    const gate = releaseGate(state);
    const approval = state.releaseApproval;
    if (
      !gate.ok ||
      !approval ||
      !operation.package ||
      state.version !== operation.expectedVersion ||
      evidenceHash(approval) !== operation.package.approvalHash ||
      operation.package.path !== `Redacted for sharing/${approval.manifest.releaseId}`
    )
      throw new Error('RELEASE_UNAPPROVED');
    const expected = approval.manifest.files.map((file) => ({
      path: `${operation.package?.path}/${file.name}`,
      hash: file.hash,
      documentId: file.documentId,
    }));
    expected.push({
      path: `${operation.package.path}/manifest.json`,
      hash: bytesHash(Buffer.from(`${JSON.stringify(approval.manifest, null, 2)}\n`)),
      documentId: approval.manifest.files[0]?.documentId ?? '',
    });
    if (
      operation.artifacts.length !== expected.length ||
      operation.artifacts.some((artifact, index) => {
        const item = expected[index];
        return (
          !item ||
          artifact.role !== 'release' ||
          artifact.path !== item.path ||
          artifact.hash !== item.hash ||
          artifact.documentId !== item.documentId
        );
      })
    )
      throw new Error('CASE_INTEGRITY_ERROR');
    const next = {
      ...state,
      version: state.version + 1,
      releaseApproval: undefined,
      releases: [
        ...(state.releases ?? []),
        { approval, path: operation.package.path, at: operation.nextState.releases?.at(-1)?.at },
      ],
    };
    if (evidenceHash(next) !== evidenceHash(operation.nextState))
      throw new Error('CASE_INTEGRITY_ERROR');
  }
  private async checkPackage(directory: string, artifacts: Artifact[]): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CASE_INTEGRITY_ERROR');
    const names = await readdir(directory);
    if (
      names.length !== artifacts.length ||
      names.some((name) => !artifacts.some((item) => basename(item.path) === name))
    )
      throw new Error('CASE_INTEGRITY_ERROR');
    for (const artifact of artifacts) {
      const path = join(directory, basename(artifact.path));
      const file = await lstat(path);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        file.size !== artifact.size ||
        bytesHash(await readFile(path)) !== artifact.hash
      )
        throw new Error('CASE_INTEGRITY_ERROR');
    }
  }
  async publish(expectedVersion: number): Promise<StudioState> {
    if (this.busy) throw new Error('CASE_BUSY');
    this.busy = true;
    try {
      const state = this.state();
      if (state.version !== expectedVersion) throw new Error('STATE_STALE');
      if (
        this.db
          .prepare("SELECT id FROM operations WHERE stage NOT IN ('complete','aborted') LIMIT 1")
          .get()
      )
        throw new Error('CASE_INTEGRITY_ERROR');
      await this.validate();
      const approval = state.releaseApproval;
      const gate = releaseGate(state);
      if (!approval || !gate.ok)
        throw new Error(gate.ok ? 'RELEASE_UNAPPROVED' : gate.blockers[0]?.code);
      const path = `Redacted for sharing/${approval.manifest.releaseId}`;
      const outputs: { artifact: Artifact; bytes: Buffer }[] = [];
      let selectedBytes = 0;
      const available = await statfs(this.root);
      for (const file of approval.manifest.files) {
        const source = this.artifacts().find(
          (item) =>
            item.role === 'candidate' &&
            item.documentId === file.documentId &&
            item.hash === file.hash,
        );
        if (!source) throw new Error('VERIFICATION_FAILED');
        selectedBytes += source.size;
        if (
          selectedBytes > 255 * 1024 * 1024 ||
          available.bavail * available.bsize < selectedBytes + 65 * 1024 * 1024
        )
          throw new Error('Release disk budget exceeded');
        const bytes = await readFile(await this.path(source.path));
        if (bytesHash(bytes) !== file.hash) throw new Error('CASE_INTEGRITY_ERROR');
        outputs.push({
          artifact: {
            path: `${path}/${file.name}`,
            documentId: file.documentId,
            role: 'release',
            hash: file.hash,
            size: bytes.length,
          },
          bytes,
        });
      }
      const manifest = Buffer.from(`${JSON.stringify(approval.manifest, null, 2)}\n`);
      const documentId = approval.manifest.files[0]?.documentId;
      if (!documentId) throw new Error('RELEASE_UNAPPROVED');
      outputs.push({
        artifact: {
          path: `${path}/manifest.json`,
          documentId,
          role: 'release',
          hash: bytesHash(manifest),
          size: manifest.length,
        },
        bytes: manifest,
      });
      const required = outputs.reduce((sum, output) => sum + output.bytes.length, 0);
      const disk = await statfs(this.root);
      if (required > 256 * 1024 * 1024 || disk.bavail * disk.bsize < required + 64 * 1024 * 1024)
        throw new Error('Release disk budget exceeded');
      const id = randomUUID();
      const operation = operationSchema.parse({
        expectedVersion,
        artifacts: outputs.map((output) => output.artifact),
        package: { path, approvalHash: evidenceHash(approval) },
        nextState: {
          ...state,
          version: expectedVersion + 1,
          releaseApproval: undefined,
          releases: [...(state.releases ?? []), { approval, path, at: new Date().toISOString() }],
        },
      });
      this.checkPublication(operation);
      if (Buffer.byteLength(JSON.stringify(operation.nextState)) > 32 * 1024 * 1024)
        throw new Error('Case metadata budget exceeded');
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?)')
        .run(id, 'intent', JSON.stringify(operation));
      this.observer?.('intent');
      const staging = join(this.root, '.studio/staging', id);
      await privateDirectory(join(staging, 'package'));
      for (const output of outputs) {
        const handle = await open(
          join(staging, 'package', basename(output.artifact.path)),
          'wx',
          0o600,
        );
        try {
          await handle.writeFile(output.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(join(staging, 'package'));
      await syncDirectory(staging);
      this.db.prepare('UPDATE operations SET stage=? WHERE id=?').run('prepared', id);
      this.observer?.('prepared');
      this.checkPublication(operation);
      await this.checkPackage(join(staging, 'package'), operation.artifacts);
      this.binding.promoteDirectory(
        join(staging, 'package'),
        await this.path(`${path}/manifest.json`).then(dirname),
      );
      await syncDirectory(join(this.root, 'Redacted for sharing'));
      await syncDirectory(staging);
      this.observer?.('promoted');
      this.finish(id, operation);
      this.observer?.('committed');
      await rm(staging, { recursive: true });
      return this.state();
    } finally {
      this.busy = false;
    }
  }
  private async recover(): Promise<void> {
    for (const row of this.db
      .prepare(
        "SELECT id,stage,json FROM operations WHERE stage NOT IN ('complete','aborted') ORDER BY rowid",
      )
      .all()) {
      const id = z.string().uuid().parse(row.id);
      z.enum(['intent', 'prepared']).parse(row.stage);
      const operation = operationSchema.parse(JSON.parse(String(row.json)));
      if (this.state().version !== operation.expectedVersion)
        throw new Error('CASE_INTEGRITY_ERROR');
      const staging = join(this.root, '.studio/staging', id);
      if (operation.package) {
        this.checkPublication(operation);
        const target = dirname(await this.path(`${operation.package.path}/manifest.json`));
        let promoted = false;
        try {
          await lstat(target);
          promoted = true;
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (promoted) {
          if (row.stage !== 'prepared') throw new Error('CASE_INTEGRITY_ERROR');
          await this.checkPackage(target, operation.artifacts);
        }
        try {
          const info = await lstat(staging);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CASE_INTEGRITY_ERROR');
          const entries = await readdir(staging);
          if (entries.some((name) => name !== 'package') || (promoted && entries.length))
            throw new Error('CASE_INTEGRITY_ERROR');
          if (entries.includes('package')) {
            // An incomplete intent may own only a subset; validate each before deleting it.
            const directory = join(staging, 'package');
            const names = await readdir(directory);
            await this.checkPackage(
              directory,
              operation.artifacts.filter((artifact) => names.includes(basename(artifact.path))),
            );
          }
          await rm(staging, { recursive: true });
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (promoted) this.finish(id, operation);
        else this.db.prepare('UPDATE operations SET stage=? WHERE id=?').run('aborted', id);
        continue;
      }
      try {
        const stagingInfo = await lstat(staging);
        if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink())
          throw new Error('CASE_INTEGRITY_ERROR');
        for (const name of await readdir(staging)) {
          const info = await lstat(join(staging, name));
          if (
            !operation.artifacts.some((_, index) => name === String(index)) ||
            !info.isFile() ||
            info.isSymbolicLink()
          )
            throw new Error('CASE_INTEGRITY_ERROR');
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      let present = 0;
      for (const [index, artifact] of operation.artifacts.entries()) {
        const target = await this.path(artifact.path);
        try {
          const info = await lstat(target);
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            bytesHash(await readFile(target)) !== artifact.hash
          )
            throw new Error('CASE_INTEGRITY_ERROR');
          if (info.nlink === 2) {
            const temporary = join(staging, String(index));
            const staged = await lstat(temporary);
            if (staged.ino !== info.ino || staged.dev !== info.dev)
              throw new Error('CASE_INTEGRITY_ERROR');
            await unlink(temporary);
          } else if (info.nlink !== 1) throw new Error('CASE_INTEGRITY_ERROR');
          present++;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (present && row.stage !== 'prepared') throw new Error('CASE_INTEGRITY_ERROR');
      if (present) {
        for (const [index, artifact] of operation.artifacts.entries()) {
          const target = await this.path(artifact.path, true);
          try {
            await lstat(target);
          } catch (error) {
            if (!missing(error)) throw error;
            const temp = join(staging, String(index));
            const info = await lstat(temp);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
              throw new Error('CASE_INTEGRITY_ERROR');
            if (bytesHash(await readFile(temp)) !== artifact.hash)
              throw new Error('CASE_INTEGRITY_ERROR');
            await link(temp, target);
            await unlink(temp);
            await syncDirectory(dirname(target));
          }
        }
        this.finish(id, operation);
      } else this.db.prepare('UPDATE operations SET stage=? WHERE id=?').run('aborted', id);
      await rm(staging, { recursive: true, force: true });
    }
    for (const [id, files] of this.jobFiles()) {
      await this.checkScratch(id, files);
      await rm(join(this.root, '.studio/staging', id), { recursive: true, force: true });
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    }
  }
  private jobFiles(): Map<string, Set<string>> {
    return new Map(
      this.db
        .prepare('SELECT id,json FROM jobs')
        .all()
        .map((row) => [
          z.string().uuid().parse(row.id),
          new Set(
            z
              .array(
                z
                  .string()
                  .regex(/^[a-zA-Z0-9._-]{1,80}$/)
                  .refine((name) => name !== '.' && name !== '..'),
              )
              .max(100)
              .parse(JSON.parse(String(row.json))),
          ),
        ]),
    );
  }
  private async checkScratch(id: string, files: Set<string>): Promise<void> {
    const directory = join(this.root, '.studio/staging', id);
    try {
      await this.path(`.studio/staging/${id}/placeholder`);
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new Error('CASE_INTEGRITY_ERROR');
      for (const name of await readdir(directory)) {
        const info = await lstat(join(directory, name));
        if (name === 'office' && files.has(name) && info.isDirectory() && !info.isSymbolicLink()) {
          await this.checkOfficeTree(join(directory, name));
          continue;
        }
        if (!files.has(name) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error('CASE_INTEGRITY_ERROR');
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  /** Office may populate only this declared job-owned tree, never the rest of the case. */
  private async checkOfficeTree(directory: string): Promise<void> {
    let entries = 0;
    let bytes = 0;
    const visit = async (path: string, depth = 0, temporary = false): Promise<void> => {
      if (depth > 24 || ++entries > 20000) throw new Error('CASE_INTEGRITY_ERROR');
      const info = await lstat(path);
      if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
        throw new Error('CASE_INTEGRITY_ERROR');
      if (info.isDirectory()) {
        for (const name of await readdir(path)) {
          if (
            !depth &&
            !['profile', 'pdf', 'cache', 'tmp'].includes(name) &&
            !/^document\.[a-z0-9]{1,12}$/.test(name)
          )
            throw new Error('CASE_INTEGRITY_ERROR');
          await visit(join(path, name), depth + 1, temporary || (!depth && name === 'tmp'));
        }
      } else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (bytes > 384 * 1024 * 1024) throw new Error('CASE_INTEGRITY_ERROR');
      } else if (!temporary || !info.isSocket()) throw new Error('CASE_INTEGRITY_ERROR');
    };
    const root = await lstat(directory);
    if (!root.isDirectory() || root.mode & 0o077) throw new Error('CASE_INTEGRITY_ERROR');
    await visit(directory);
  }

  async validate(): Promise<void> {
    for (const [index, path] of [this.root, join(this.root, '.studio/locks/case.lock')].entries()) {
      const fd = this.lock[index];
      if (fd === undefined) throw new Error('CASE_LOCK_UNAVAILABLE');
      const held = fstatSync(fd);
      const current = await lstat(path).catch(() => {
        throw new Error('CASE_INTEGRITY_ERROR');
      });
      if (held.ino !== current.ino || held.dev !== current.dev || current.isSymbolicLink())
        throw new Error('CASE_INTEGRITY_ERROR');
    }
    const known = new Set([
      '.studio/case.sqlite',
      '.studio/case.sqlite-journal',
      '.studio/case.json',
      '.studio/locks/case.lock',
    ]);
    for (const artifact of this.artifacts()) {
      const path = await this.path(artifact.path);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== artifact.size ||
        bytesHash(await readFile(path)) !== artifact.hash
      )
        throw new Error('CASE_INTEGRITY_ERROR');
      known.add(artifact.path);
    }
    const jobs = this.jobFiles();
    const officeRoots = new Set(
      [...jobs]
        .filter(([, files]) => files.has('office'))
        .map(([id]) => `.studio/staging/${id}/office`),
    );
    const checkOffice = (path: string) => this.checkOfficeTree(path);
    async function visit(root: string, prefix = ''): Promise<void> {
      if (officeRoots.has(prefix)) {
        await checkOffice(root);
        return;
      }
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('CASE_INTEGRITY_ERROR');
        if (entry.isDirectory()) {
          if (!prefix && !roots.includes(entry.name as (typeof roots)[number]))
            throw new Error('CASE_INTEGRITY_ERROR');
          await visit(join(root, entry.name), name);
        } else if (
          !entry.isFile() ||
          (!known.has(name) &&
            ![...jobs].some(
              ([id, files]) =>
                name.startsWith(`.studio/staging/${id}/`) &&
                files.has(name.slice(`.studio/staging/${id}/`.length)),
            ))
        )
          throw new Error('CASE_INTEGRITY_ERROR');
      }
    }
    await visit(this.root);
  }
  async scratch(
    files = ['input.pdf', 'output.pdf', 'request.json', 'render.json', 'evidence.json'],
  ): Promise<{ id: string; path: string }> {
    if (this.closed || this.busy) throw new Error('CASE_BUSY');
    const allowed = z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,80}$/)
          .refine((name) => name !== '.' && name !== '..'),
      )
      .max(100)
      .parse(files);
    const id = randomUUID();
    this.db.prepare('INSERT INTO jobs VALUES(?,?)').run(id, JSON.stringify(allowed));
    const path = join(this.root, '.studio/staging', id);
    await privateDirectory(path);
    return { id, path };
  }
  async clearScratch(id: string): Promise<void> {
    const files = this.jobFiles().get(z.string().uuid().parse(id));
    if (!files) throw new Error('CASE_INTEGRITY_ERROR');
    await this.checkScratch(id, files);
    await rm(join(this.root, '.studio/staging', id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  }
  async backup(destination: string): Promise<void> {
    if (this.busy) throw new Error('CASE_BUSY');
    this.busy = true;
    try {
      await this.validate();
      let target = resolve(destination);
      if (target === this.root || target.startsWith(`${this.root}${sep}`))
        throw new Error('Backup must be outside the case');
      await emptyPrivateDirectory(target);
      target = await realpath(target);
      if (target === this.root || target.startsWith(`${this.root}${sep}`))
        throw new Error('Backup must be outside the case');
      if (this.jobFiles().size) throw new Error('CASE_BUSY');
      if ((await readdir(target)).length) throw new Error('Backup folder must be empty');
      for (const directory of roots) await privateDirectory(join(target, directory));
      for (const directory of ['locks', 'staging', 'candidates', 'snapshots'])
        await privateDirectory(join(target, '.studio', directory));
      await backup(this.db, join(target, '.studio/case.sqlite'));
      await chmod(join(target, '.studio/case.sqlite'), 0o600);
      await copyFile(
        join(this.root, '.studio/case.json'),
        join(target, '.studio/case.json'),
        constants.COPYFILE_EXCL,
      );
      for (const artifact of this.artifacts()) {
        const output = join(target, artifact.path);
        await privateDirectory(dirname(output));
        await copyFile(await this.path(artifact.path), output, constants.COPYFILE_EXCL);
      }
      await syncDirectory(join(target, '.studio'));
      await syncDirectory(target);
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    if (this.closed) return;
    if (this.busy) throw new Error('CASE_BUSY');
    this.db.close();
    this.lock.forEach(closeSync);
    this.closed = true;
  }
}
