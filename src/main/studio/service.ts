import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app, type BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import {
  documentGate,
  evidenceHash,
  markSchema,
  type Plan,
  type StudioDocument,
  type StudioState,
  validatePlan,
} from '../../core/studio/domain';
import { originKey } from '../../shared/security';
import type { Snapshot, StudioView } from '../../shared/studio';
import { StudioRuntime, snapshotSchema } from './runtime';
import { type Artifact, bytesHash, CaseStore, nativeCaseLock } from './store';

const idSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ id: idSchema, version: z.number().int().nonnegative() }).strict();
const revisionRequest = z.object({ id: idSchema, revisionHash: hashSchema }).strict();
export class StudioService {
  store: CaseStore | undefined;
  readonly runtime = new StudioRuntime();
  private active: Promise<unknown> | undefined;
  private controller: AbortController | undefined;
  constructor(private readonly window: BrowserWindow) {}
  private current(): CaseStore {
    if (!this.store) throw new Error('Open a working folder first.');
    return this.store;
  }
  private document(state: StudioState, id: string): StudioDocument {
    const document = state.documents.find((item) => item.id === id);
    if (!document) throw new Error('Unknown document');
    return document;
  }
  private lock() {
    return nativeCaseLock(
      app.isPackaged
        ? join(process.resourcesPath, 'native/studio-lock.node')
        : join(app.getAppPath(), 'resources/native/studio-lock.node'),
    );
  }
  private async ready() {
    const status = await this.runtime.status();
    if (!status.available) throw new Error(status.reason ?? 'Studio runtime unavailable');
    return status;
  }
  async view(): Promise<StudioView> {
    const status = await this.runtime.status();
    const state = this.store?.state();
    return {
      available: status.available,
      reason: status.reason,
      profile: 'fedora-raster-v1',
      ...(state && this.store
        ? {
            case: {
              state,
              label: basename(this.store.root),
              names: Object.fromEntries(
                state.documents.map((document) => [
                  document.id,
                  this.current().source(document.id).originalName,
                ]),
              ),
              blockers: Object.fromEntries(
                state.documents.map((document) => {
                  const gate = documentGate(state, document);
                  return [document.id, gate.ok ? [] : gate.blockers];
                }),
              ),
            },
          }
        : {}),
    };
  }
  async run<T>(callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('CASE_BUSY');
    const controller = new AbortController();
    this.controller = controller;
    const task = callback(controller.signal);
    this.active = task;
    try {
      return await task;
    } finally {
      if (this.active === task) {
        this.active = undefined;
        this.controller = undefined;
      }
    }
  }
  async create(): Promise<StudioView> {
    const status = await this.ready();
    const selected = await dialog.showOpenDialog(this.window, {
      title: 'Choose an empty local working folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return this.view();
    const store = await CaseStore.create(
      path,
      this.lock(),
      evidenceHash({ id: 'raster-policy-v1', completePageReview: true, imageOnly: true }),
      status.contractHash,
    );
    this.store?.close();
    this.store = store;
    return this.view();
  }
  async open(): Promise<StudioView> {
    await this.ready();
    const selected = await dialog.showOpenDialog(this.window, {
      title: 'Open a managed working folder',
      properties: ['openDirectory'],
    });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return this.view();
    if (this.store && (await realpath(path)) === this.store.root) return this.view();
    const store = await CaseStore.open(path, this.lock());
    this.store?.close();
    this.store = store;
    return this.view();
  }
  async close(): Promise<StudioView> {
    this.store?.close();
    this.store = undefined;
    return this.view();
  }
  async backup(): Promise<StudioView> {
    const selected = await dialog.showOpenDialog(this.window, {
      title: 'Choose an empty private backup folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = selected.filePaths[0];
    if (!selected.canceled && path) await this.current().backup(path);
    return this.view();
  }
  async import(signal: AbortSignal): Promise<StudioView> {
    const store = this.current();
    const selected = await dialog.showOpenDialog(this.window, {
      title: 'Capture PDFs for review',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    for (const path of selected.filePaths) {
      signal.throwIfAborted();
      if (extname(path).toLowerCase() !== '.pdf')
        throw new Error('Only PDFs are supported in this slice.');
      await store.capture(path, store.state().version, signal);
    }
    return this.view();
  }
  async artifact(
    documentId: string,
    role: Artifact['role'],
    hash?: string,
  ): Promise<{ bytes: Buffer; artifact: Artifact }> {
    const store = this.current();
    const artifact = store
      .artifacts()
      .find(
        (item) =>
          item.documentId === documentId && item.role === role && (!hash || item.hash === hash),
      );
    if (!artifact) throw new Error('CASE_INTEGRITY_ERROR');
    const path = await store.path(artifact.path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 100 * 1024 * 1024
    )
      throw new Error('CASE_INTEGRITY_ERROR');
    const bytes = await readFile(path);
    if (bytesHash(bytes) !== artifact.hash) throw new Error('CASE_INTEGRITY_ERROR');
    return { bytes, artifact };
  }
  async prepare(value: unknown, signal: AbortSignal): Promise<StudioView> {
    const request = requestSchema.parse(value);
    const status = await this.ready();
    const store = this.current();
    const state = store.state();
    if (state.version !== request.version) throw new Error('STATE_STALE');
    if (state.contractHash !== status.contractHash)
      throw new Error('The case profile needs migration before processing.');
    const document = this.document(state, request.id);
    if (document.revision) return this.view();
    const source = await this.artifact(document.id, 'source', document.sourceHash);
    const job = await store.scratch();
    let failure: unknown;
    try {
      await writeFile(join(job.path, 'input.pdf'), source.bytes, { mode: 0o600 });
      await this.runtime.checker(job.path, 'qpdf', ['--check', '/work/input.pdf'], signal);
      const graph: unknown = JSON.parse(
        await this.runtime.checker(
          job.path,
          'qpdf',
          ['--json', '--json-stream-data=none', '/work/input.pdf'],
          signal,
        ),
      );
      const pages = this.runtime.metadata(graph);
      const snapshot = await this.runtime.render(source.bytes, pages, status.engine, signal);
      if (snapshot.revisionHash !== document.sourceHash) throw new Error('SOURCE_CHANGED');
      const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
      const snapshotHash = bytesHash(snapshotBytes);
      document.revision = {
        hash: document.sourceHash,
        snapshotHash,
        sourceHash: document.sourceHash,
        pages,
        converter: status.engine,
      };
      document.plan = {
        id: randomUUID(),
        revisionHash: document.sourceHash,
        marks: [],
        reviewedPages: [],
      };
      document.candidate = undefined;
      document.failure = undefined;
      await store.transition(request.version, state, [
        {
          artifact: {
            path: `For Redaction/${document.id}/${randomUUID()}/review.pdf`,
            documentId: document.id,
            role: 'revision',
          },
          bytes: source.bytes,
        },
        {
          artifact: {
            path: `.studio/snapshots/${document.id}/${snapshotHash}.json`,
            documentId: document.id,
            role: 'snapshot',
          },
          bytes: snapshotBytes,
        },
      ]);
    } catch (error) {
      failure = error;
    } finally {
      await store.clearScratch(job.id);
    }
    if (failure) {
      if (!signal.aborted && store.state().version === request.version) {
        const next = store.state();
        this.document(next, document.id).failure = 'PREPARATION_FAILED';
        await store.transition(request.version, next);
      }
      throw new Error(signal.aborted ? 'CANCELLED' : 'PDF_PREPARATION_FAILED');
    }
    return this.view();
  }
  async loadSnapshot(id: string, revisionHash: string): Promise<Snapshot> {
    const document = this.document(this.current().state(), id);
    if (document.revision?.hash !== revisionHash) throw new Error('PLAN_STALE');
    const value: unknown = JSON.parse(
      (await this.artifact(id, 'snapshot', document.revision.snapshotHash)).bytes.toString(),
    );
    const snapshot = snapshotSchema.parse(value);
    if (snapshot.revisionHash !== revisionHash) throw new Error('CASE_INTEGRITY_ERROR');
    return snapshot;
  }
  async snapshot(value: unknown) {
    const request = revisionRequest.extend({ snapshotHash: hashSchema }).strict().parse(value);
    if (
      this.document(this.current().state(), request.id).revision?.snapshotHash !==
      request.snapshotHash
    )
      throw new Error('PLAN_STALE');
    const snapshot = await this.loadSnapshot(request.id, request.revisionHash);
    return {
      ...snapshot,
      pages: snapshot.pages.map(({ referenceRgb: _private, ...page }) => page),
    };
  }
  private async persistPlan(id: string, version: number, plan: Plan): Promise<StudioView> {
    const store = this.current();
    const state = store.state();
    if (state.version !== version) throw new Error('STATE_STALE');
    const document = this.document(state, id);
    if (!document.revision) throw new Error('PREPARATION_FAILED');
    const next = validatePlan(document.revision, plan);
    if (document.plan && evidenceHash(document.plan) === evidenceHash(next)) return this.view();
    document.plan = next;
    document.candidate = undefined;
    const path = `.studio/plans/${id}/${evidenceHash(next)}.json`;
    const outputs = store.artifacts().some((item) => item.path === path)
      ? []
      : [
          {
            artifact: { path, documentId: id, role: 'evidence' as const },
            bytes: Buffer.from(JSON.stringify(next)),
          },
        ];
    await store.transition(version, state, outputs);
    return this.view();
  }
  async saveMarks(value: unknown): Promise<StudioView> {
    const request = requestSchema
      .extend({ revisionHash: hashSchema, marks: z.array(markSchema).max(10_000) })
      .strict()
      .parse(value);
    const document = this.document(this.current().state(), request.id);
    if (!document.plan || document.plan.revisionHash !== request.revisionHash)
      throw new Error('PLAN_STALE');
    if (evidenceHash(document.plan.marks) === evidenceHash(request.marks)) return this.view();
    return this.persistPlan(request.id, request.version, {
      ...document.plan,
      marks: request.marks,
      reviewedPages: [],
    });
  }
  async reviewPage(value: unknown): Promise<StudioView> {
    const request = requestSchema
      .extend({
        revisionHash: hashSchema,
        page: z.number().int().nonnegative(),
        decision: z.enum(['reviewed', 'unreviewed']),
      })
      .strict()
      .parse(value);
    const document = this.document(this.current().state(), request.id);
    if (!document.plan || document.plan.revisionHash !== request.revisionHash)
      throw new Error('PLAN_STALE');
    const reviewedPages = document.plan.reviewedPages.filter((page) => page !== request.page);
    if (request.decision === 'reviewed') reviewedPages.push(request.page);
    reviewedPages.sort((a, b) => a - b);
    return this.persistPlan(request.id, request.version, { ...document.plan, reviewedPages });
  }
  async search(
    value: unknown,
  ): Promise<{ page: number; rect: [number, number, number, number]; text: string }[]> {
    const request = revisionRequest
      .extend({ phrase: z.string().min(1).max(200) })
      .strict()
      .parse(value);
    const snapshot = await this.loadSnapshot(request.id, request.revisionHash);
    const hits: { page: number; rect: [number, number, number, number]; text: string }[] = [];
    snapshot.pages.forEach((page, index) => {
      const joined = page.text.map((item) => item.text).join(' ');
      let from = 0;
      while (hits.length < 1000) {
        const at = joined.indexOf(request.phrase, from);
        if (at < 0) break;
        let offset = 0;
        for (const item of page.text) {
          if (offset < at + request.phrase.length && offset + item.text.length > at)
            hits.push({ page: index, rect: item.rect, text: item.text.slice(0, 200) });
          offset += item.text.length + 1;
        }
        from = at + request.phrase.length;
      }
    });
    return hits.slice(0, 1000);
  }
  cancel(): void {
    this.controller?.abort();
  }
  async dispose(): Promise<void> {
    this.cancel();
    await this.active?.catch(() => {});
    this.store?.close();
    this.store = undefined;
  }
}

export function registerStudioApi(
  window: BrowserWindow,
  trustedOrigin: string,
): () => Promise<void> {
  const service = new StudioService(window);
  const names: string[] = [];
  const handle = (
    name: string,
    callback: (value: unknown, signal: AbortSignal) => Promise<unknown>,
    mutating = true,
  ) => {
    const channel = `studio:${name}`;
    names.push(channel);
    ipcMain.handle(channel, (event, value: unknown) => {
      const frame = event.senderFrame;
      if (
        event.sender.id !== window.webContents.id ||
        !frame ||
        frame.parent !== null ||
        originKey(frame.url) !== trustedOrigin
      )
        throw new Error('Untrusted studio caller');
      if (name === 'cancel') {
        service.cancel();
        return;
      }
      return mutating
        ? service.run((signal) => callback(value, signal))
        : callback(value, new AbortController().signal);
    });
  };
  handle('status', () => service.view(), false);
  handle('create', () => service.create());
  handle('open', () => service.open());
  handle('close', () => service.close());
  handle('backup', () => service.backup());
  handle('import', (_value, signal) => service.import(signal));
  handle('prepare', (value, signal) => service.prepare(value, signal));
  handle('snapshot', (value) => service.snapshot(value), false);
  handle('saveMarks', (value) => service.saveMarks(value));
  handle('reviewPage', (value) => service.reviewPage(value));
  handle('search', (value) => service.search(value), false);
  handle('cancel', async () => {});
  return async () => {
    for (const channel of names) ipcMain.removeHandler(channel);
    await service.dispose();
  };
}
