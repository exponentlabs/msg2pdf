import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants } from 'node:fs';
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
import { evidenceHash, type StudioState, studioStateSchema } from '../../core/studio/domain';

export interface CaseLock {
  acquire(path: string): number;
}
export function nativeCaseLock(binary: string): CaseLock {
  const value: unknown = createRequire(resolve(binary))(resolve(binary));
  if (
    !value ||
    typeof value !== 'object' ||
    !('acquire' in value) ||
    typeof value.acquire !== 'function'
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
    source: z
      .object({ documentId: z.string().uuid(), originalName: z.string(), origin: z.string() })
      .optional(),
  })
  .strict();
type Operation = z.infer<typeof operationSchema>;
const markerSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid() }).strict();
const roots = ['Exported', 'For Redaction', 'Redacted for sharing', '.studio'] as const;
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

export class CaseStore {
  /** Internal boundary observer supports process-interruption verification; never exposed over IPC. */
  observer: ((boundary: string) => void) | undefined;
  private busy = false;
  private closed = false;
  private constructor(
    readonly root: string,
    private readonly db: DatabaseSync,
    private readonly lock: number,
  ) {}
  static async create(
    root: string,
    lock: CaseLock,
    policyHash: string,
    contractHash: string,
  ): Promise<CaseStore> {
    const absolute = resolve(root);
    await privateDirectory(absolute);
    if ((await readdir(absolute)).length) throw new Error('Choose an empty working folder');
    await mkdir(join(absolute, '.studio'), { mode: 0o700 });
    for (const directory of roots) await privateDirectory(join(absolute, directory));
    for (const directory of ['locks', 'staging', 'candidates', 'snapshots'])
      await privateDirectory(join(absolute, '.studio', directory));
    const descriptor = lock.acquire(join(absolute, '.studio/locks/case.lock'));
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
      return new CaseStore(await realpath(absolute), db, descriptor);
    } catch (error) {
      db?.close();
      closeSync(descriptor);
      throw error;
    }
  }
  static async open(root: string, lock: CaseLock): Promise<CaseStore> {
    const absolute = await realpath(root);
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
    const descriptor = lock.acquire(join(absolute, '.studio/locks/case.lock'));
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
      const store = new CaseStore(absolute, db, descriptor);
      if (store.state().id !== marker.id) throw new Error('CASE_INTEGRITY_ERROR');
      await store.recover();
      await store.validate();
      return store;
    } catch (error) {
      db?.close();
      closeSync(descriptor);
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
      });
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
    const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
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
        if (!files.has(name) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error('CASE_INTEGRITY_ERROR');
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async validate(): Promise<void> {
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
    async function visit(root: string, prefix = ''): Promise<void> {
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
      await privateDirectory(target);
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
    closeSync(this.lock);
    this.closed = true;
  }
}
