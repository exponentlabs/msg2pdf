import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atomicWrite } from '../../src/core/filesystem';
import { createPlan } from '../../src/core/planner';
import {
  evidenceHash,
  makeReleaseManifest,
  mandatoryChecks,
  releaseFingerprint,
  reviewContext,
} from '../../src/core/studio/domain';
import { assertLegacyDestination } from '../../src/core/studio/paths';
import { bytesHash, type CaseLock, CaseStore, nativeCaseLock } from '../../src/main/studio/store';
import { requestSchema } from '../../src/shared/contracts';

describe.skipIf(process.platform !== 'linux')('durable studio store with real OS locks', () => {
  let root: string;
  let lock: CaseLock;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'msg2pdf-store-'));
    const binary = join(root, 'lock.node');
    execFileSync('cc', [
      '-shared',
      '-fPIC',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${resolve('native/linux/node-api')}`,
      resolve('native/linux/studio-lock.c'),
      '-o',
      binary,
    ]);
    lock = nativeCaseLock(binary);
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const directory = await mkdtemp(join(root, 'case-'));
    const input = join(root, `${directory.split('/').at(-1)}.pdf`);
    await writeFile(input, 'Synthetic captured bytes');
    const store = await CaseStore.create(
      directory,
      lock,
      evidenceHash('policy'),
      evidenceHash('contract'),
    );
    return { directory, input, store };
  }
  async function approved() {
    const result = await setup();
    const state = await result.store.capture(result.input, 0);
    const document = state.documents[0];
    if (!document) throw new Error('Missing fixture document');
    document.revision = {
      hash: document.sourceHash,
      snapshotHash: evidenceHash('snapshot'),
      sourceHash: document.sourceHash,
      converter: 'fixture',
      pages: [{ mediaBox: [0, 0, 400, 400], cropBox: [0, 0, 400, 400], rotation: 0, userUnit: 1 }],
    };
    document.plan = {
      id: crypto.randomUUID(),
      revisionHash: document.sourceHash,
      marks: [],
      reviewedPages: [0],
    };
    const bytes = Buffer.from('Synthetic verified candidate');
    document.candidate = {
      hash: bytesHash(bytes),
      evidenceHash: evidenceHash('evidence'),
      revisionHash: document.sourceHash,
      snapshotHash: document.revision.snapshotHash,
      planHash: evidenceHash(document.plan),
      policyHash: state.policyHash,
      contractHash: state.contractHash,
      engine: 'fixture',
      checkers: ['one', 'two'],
      checks: mandatoryChecks.map((name) => ({ name, passed: true })),
    };
    document.candidate.review = {
      candidateHash: document.candidate.hash,
      contextHash: reviewContext(state, document),
      actor: 'Local user',
      at: new Date().toISOString(),
      pages: [0],
    };
    await result.store.transition(state.version, state, [
      {
        artifact: {
          path: `.studio/candidates/${document.id}/verified.pdf`,
          role: 'candidate',
          documentId: document.id,
        },
        bytes,
      },
    ]);
    const next = result.store.state();
    const manifest = makeReleaseManifest(next, [document.id], crypto.randomUUID());
    next.releaseApproval = {
      manifest,
      manifestHash: evidenceHash(manifest),
      contextHash: releaseFingerprint({ ...next, version: next.version + 1 }, [document.id]),
      actor: 'Local user',
      at: new Date().toISOString(),
    };
    await result.store.transition(next.version, next);
    return result;
  }
  it.each(['intent', 'prepared', 'promoted', 'committed'])(
    'recovers atomic approved publication at %s',
    async (boundary) => {
      const { store, directory } = await approved();
      store.observer = (phase) => {
        if (phase === boundary) throw new Error('Interrupted');
      };
      await expect(store.publish(store.state().version)).rejects.toThrow('Interrupted');
      store.close();
      const recovered = await CaseStore.open(directory, lock);
      const completed = boundary === 'promoted' || boundary === 'committed';
      expect(recovered.state().releases?.length ?? 0).toBe(completed ? 1 : 0);
      const entries = await readdir(join(directory, 'Redacted for sharing'));
      expect(entries).toHaveLength(completed ? 1 : 0);
      if (completed && entries[0])
        expect(await readdir(join(directory, 'Redacted for sharing', entries[0]))).toEqual([
          'document-001.pdf',
          'manifest.json',
        ]);
      await recovered.validate();
      recovered.close();
    },
  );
  it('blocks stale approvals and refuses native directory replacement', async () => {
    const { store } = await approved();
    const state = store.state();
    await store.transition(state.version, state);
    await expect(store.publish(store.state().version)).rejects.toThrow('RELEASE_UNAPPROVED');
    store.close();
    const first = await mkdtemp(join(root, 'native-first-'));
    const second = await mkdtemp(join(root, 'native-second-'));
    expect(() => lock.promoteDirectory(first, second)).toThrow();
  });
  it('captures a private immutable source with provenance and survives relocation/reopen', async () => {
    const { directory, input, store } = await setup();
    const state = await store.capture(input, 0);
    expect(state.version).toBe(1);
    expect(state.documents).toHaveLength(1);
    const document = state.documents[0];
    const artifact = store.artifacts()[0];
    if (!document || !artifact) throw new Error('No captured source');
    expect(store.source(document.id).origin).toBe(input);
    expect(await readFile(await store.path(artifact.path), 'utf8')).toBe(
      'Synthetic captured bytes',
    );
    await expect(CaseStore.open(directory, lock)).rejects.toMatchObject({ code: 'CASE_BUSY' });
    store.close();
    const relocated = `${directory}-relocated`;
    await rename(directory, relocated);
    const reopened = await CaseStore.open(relocated, lock);
    expect(reopened.state()).toEqual(state);
    await reopened.validate();
    reopened.close();
  });
  it.each(['intent', 'prepared', 'promoted', 'committed'])(
    'recovers an interruption at %s without adopting unknown bytes',
    async (boundary) => {
      const { directory, input, store } = await setup();
      store.observer = (phase) => {
        if (phase === boundary) throw new Error('Interrupted');
      };
      await expect(store.capture(input, 0)).rejects.toThrow('Interrupted');
      store.close();
      const recovered = await CaseStore.open(directory, lock);
      expect(recovered.state().version).toBe(
        boundary === 'intent' || boundary === 'prepared' ? 0 : 1,
      );
      expect(recovered.artifacts()).toHaveLength(
        boundary === 'intent' || boundary === 'prepared' ? 0 : 1,
      );
      await recovered.validate();
      recovered.close();
    },
  );
  it('rejects stale writes and changes to captured artifacts', async () => {
    const { directory, input, store } = await setup();
    await store.capture(input, 0);
    await expect(store.capture(input, 0)).rejects.toThrow('STATE_STALE');
    const artifact = store.artifacts()[0];
    if (!artifact) throw new Error('Missing artifact');
    await writeFile(await store.path(artifact.path), 'Externally changed');
    await expect(store.validate()).rejects.toThrow('CASE_INTEGRITY_ERROR');
    store.close();
    await expect(CaseStore.open(directory, lock)).rejects.toThrow('CASE_INTEGRITY_ERROR');
  });
  it('keeps altered prepared artifacts blocked after interruption', async () => {
    const { directory, input, store } = await setup();
    store.observer = (phase) => {
      if (phase === 'promoted') throw new Error('Interrupted');
    };
    await expect(store.capture(input, 0)).rejects.toThrow('Interrupted');
    store.close();
    const db = new DatabaseSync(join(directory, '.studio/case.sqlite'));
    const row = db.prepare("SELECT json FROM operations WHERE stage='prepared'").get();
    if (!row || typeof row.json !== 'string') throw new Error('No prepared intent');
    const payload: unknown = JSON.parse(row.json);
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('artifacts' in payload) ||
      !Array.isArray(payload.artifacts)
    )
      throw new Error('Invalid intent');
    const artifact: unknown = payload.artifacts[0];
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      !('path' in artifact) ||
      typeof artifact.path !== 'string'
    )
      throw new Error('Missing artifact');
    db.close();
    await writeFile(join(directory, artifact.path), 'Unexpected replacement');
    await expect(CaseStore.open(directory, lock)).rejects.toThrow('CASE_INTEGRITY_ERROR');
  });
  it('backs up database and artifacts consistently and refuses unsupported schemas', async () => {
    const { directory, input, store } = await setup();
    const state = await store.capture(input, 0);
    const destination = `${directory}-backup`;
    await store.backup(destination);
    store.close();
    const restored = await CaseStore.open(destination, lock);
    expect(restored.state()).toEqual(state);
    await restored.validate();
    restored.close();
    const db = new DatabaseSync(join(directory, '.studio/case.sqlite'));
    db.exec('PRAGMA user_version=99');
    db.close();
    await expect(CaseStore.open(directory, lock)).rejects.toThrow('Unsupported case schema');
  });
  it('does not count cancelled intake, follow symlink sources or recursively ingest its own artifacts', async () => {
    const { directory, input, store } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(store.capture(input, 0, controller.signal)).rejects.toThrow();
    expect(store.state().documents).toHaveLength(0);
    const alias = `${input}.link.pdf`;
    await symlink(input, alias);
    await expect(store.capture(alias, 0)).rejects.toThrow();
    await expect(store.capture(directory, 0)).rejects.toThrow('Recursive');
    store.close();
  });
  it('blocks unknown files, symlink destinations and unsafe relative artifact paths', async () => {
    const { directory, store } = await setup();
    await expect(store.path('../escape')).rejects.toThrow('CASE_INTEGRITY_ERROR');
    await symlink(root, join(directory, 'For Redaction', 'alias'));
    await expect(store.path('For Redaction/alias/file.pdf', true)).rejects.toThrow(
      'CASE_INTEGRITY_ERROR',
    );
    await rm(join(directory, 'For Redaction/alias'));
    await writeFile(join(directory, 'Redacted for sharing', 'unapproved.pdf'), 'Unknown');
    await expect(store.validate()).rejects.toThrow('CASE_INTEGRITY_ERROR');
    store.close();
  });
  it('prevents legacy conversion and report writes, including aliased ancestors', async () => {
    const { directory, input, store } = await setup();
    const output = join(directory, 'Redacted for sharing', 'new');
    await expect(
      createPlan(requestSchema.parse({ inputs: [input], output, options: {} })),
    ).rejects.toThrow('managed case');
    await expect(
      atomicWrite(
        join(directory, 'For Redaction', 'report.json'),
        join(directory, 'For Redaction'),
        Buffer.from('{}'),
        true,
      ),
    ).rejects.toThrow('managed case');
    const alias = `${directory}-alias`;
    await symlink(join(directory, 'For Redaction'), alias);
    await expect(assertLegacyDestination(join(alias, 'nested', 'report.json'))).rejects.toThrow(
      'managed case',
    );
    expect(await readdir(join(directory, 'For Redaction'))).toEqual([]);
    store.close();
  });
  it('reconciles only registered scratch files and preserves unknown material as an integrity failure', async () => {
    const first = await setup();
    const job = await first.store.scratch(['input.pdf']);
    await writeFile(join(job.path, 'input.pdf'), 'Incomplete worker input');
    first.store.close();
    const recovered = await CaseStore.open(first.directory, lock);
    expect(await readdir(join(first.directory, '.studio/staging'))).toEqual([]);
    recovered.close();
    const second = await setup();
    const unknown = await second.store.scratch(['input.pdf']);
    await writeFile(join(unknown.path, 'unexpected.txt'), 'Preserve for investigation');
    second.store.close();
    await expect(CaseStore.open(second.directory, lock)).rejects.toThrow('CASE_INTEGRITY_ERROR');
    expect(await readFile(join(unknown.path, 'unexpected.txt'), 'utf8')).toBe(
      'Preserve for investigation',
    );
  });
  it('refuses a backup routed into the case through an aliased parent', async () => {
    const { directory, store } = await setup();
    const alias = `${directory}-backup-alias`;
    await symlink(directory, alias);
    await expect(store.backup(join(alias, 'nested-backup'))).rejects.toThrow('outside the case');
    store.close();
  });
});
