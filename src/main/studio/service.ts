import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { z } from 'zod';
import {
  documentGate,
  evidenceHash,
  makeReleaseManifest,
  mandatoryChecks,
  markSchema,
  type Plan,
  releaseFingerprint,
  releaseGate,
  reviewContext,
  type StudioDocument,
  type StudioState,
  validatePlan,
} from '../../core/studio/domain';
import { pixelRegion } from '../../core/studio/geometry';
import { decodePpm, encodeRgbPng } from '../../core/studio/png';
import { originKey } from '../../shared/security';
import type { Snapshot, StudioView } from '../../shared/studio';
import { StudioRuntime, snapshotSchema } from './runtime';
import { type Artifact, bytesHash, CaseStore, nativeCaseLock } from './store';

const idSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ id: idSchema, version: z.number().int().nonnegative() }).strict();
const revisionRequest = z.object({ id: idSchema, revisionHash: hashSchema }).strict();
const candidateEvidenceSchema = z
  .object({
    candidateHash: hashSchema,
    snapshotHash: hashSchema,
    planHash: hashSchema,
    policyHash: hashSchema,
    contractHash: hashSchema,
    engine: z.string(),
    checkers: z.array(z.string()),
    pages: z
      .array(
        z
          .object({
            width: z.number().positive(),
            height: z.number().positive(),
            png: z.string().max(24 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
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
                  const blockers = gate.ok ? [] : gate.blockers;
                  if (
                    document.candidate &&
                    (!status.available ||
                      document.candidate.engine !== status.engine ||
                      JSON.stringify(document.candidate.checkers) !==
                        JSON.stringify(status.checkers))
                  )
                    blockers.push({ code: 'VERIFICATION_FAILED', documentId: document.id });
                  return [document.id, blockers];
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
    if (this.current().state().version !== request.version) throw new Error('STATE_STALE');
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
  async apply(value: unknown, signal: AbortSignal): Promise<StudioView> {
    const request = requestSchema.parse(value);
    const status = await this.ready();
    const store = this.current();
    const state = store.state();
    if (request.version !== state.version) throw new Error('STATE_STALE');
    const document = this.document(state, request.id);
    const { revision, plan } = document;
    if (!revision || !plan || document.failure || revision.sourceHash !== document.sourceHash)
      throw new Error('PREPARATION_FAILED');
    validatePlan(revision, plan);
    if (revision.pages.some((_, index) => !plan.reviewedPages.includes(index)))
      throw new Error('PAGE_UNREVIEWED');
    if (state.contractHash !== status.contractHash) throw new Error('CASE_POLICY_STALE');
    await store.validate();
    const snapshot = await this.loadSnapshot(document.id, revision.hash);
    const pages = snapshot.pages.map((page, index) => ({
      ...page,
      regions: plan.marks
        .filter((mark) => mark.page === index)
        .map((mark) => pixelRegion(page.transform, mark.rect, page.width, page.height)),
    }));
    const job = await store.scratch([
      'input.pdf',
      'output.pdf',
      'request.json',
      ...pages.map((_, index) => `page-${index + 1}.ppm`),
    ]);
    try {
      await writeFile(join(job.path, 'request.json'), JSON.stringify({ pages }), { mode: 0o600 });
      await this.runtime.worker(
        job.path,
        'assemble.cjs',
        ['/work/request.json', '/work/output.pdf'],
        signal,
      );
      const policy = z
        .object({
          profile: z.literal('raster-v1'),
          sha256: hashSchema,
          independentlyAllowlisted: z.literal(true),
          objects: z.number().int(),
          pages: z.number().int(),
        })
        .strict()
        .parse(
          JSON.parse(
            await this.runtime.checker(
              job.path,
              'raster',
              ['/work/output.pdf', '/work/request.json'],
              signal,
            ),
          ),
        );
      const text = await this.runtime.checker(
        job.path,
        'pdftotext',
        ['/work/output.pdf', '-'],
        signal,
      );
      if (text.trim()) throw new Error('VERIFICATION_FAILED');
      const attachments = await this.runtime.checker(
        job.path,
        'pdfdetach',
        ['-list', '/work/output.pdf'],
        signal,
      );
      if (!/^0 embedded files/.test(attachments)) throw new Error('VERIFICATION_FAILED');
      const info = await this.runtime.checker(job.path, 'pdfinfo', ['/work/output.pdf'], signal);
      if (!new RegExp(`Pages:\\s+${pages.length}\\b`).test(info))
        throw new Error('VERIFICATION_FAILED');
      const previewPages: { width: number; height: number; png: string }[] = [];
      for (const [index, page] of pages.entries()) {
        signal.throwIfAborted();
        await this.runtime.checker(
          job.path,
          'pdftoppm',
          [
            '-f',
            String(index + 1),
            '-l',
            String(index + 1),
            '-singlefile',
            '-cropbox',
            '-scale-dimension-before-rotation',
            '-scale-to-x',
            String(Math.ceil(page.width * 2)),
            '-scale-to-y',
            String(Math.ceil(page.height * 2)),
            '/work/output.pdf',
            `/work/page-${index + 1}`,
          ],
          signal,
        );
        const rendered = decodePpm(await readFile(join(job.path, `page-${index + 1}.ppm`)));
        if (
          rendered.width !== Math.ceil(page.width * 2) ||
          rendered.height !== Math.ceil(page.height * 2)
        )
          throw new Error('VERIFICATION_FAILED');
        previewPages.push({
          width: page.width,
          height: page.height,
          png: encodeRgbPng(rendered.width, rendered.height, rendered.rgb).toString('base64'),
        });
      }
      const bytes = await readFile(join(job.path, 'output.pdf'));
      if (bytesHash(bytes) !== policy.sha256) throw new Error('VERIFICATION_FAILED');
      const current = await this.ready();
      if (
        current.engine !== status.engine ||
        JSON.stringify(current.checkers) !== JSON.stringify(status.checkers) ||
        current.contractHash !== status.contractHash
      )
        throw new Error('VERIFIER_CHANGED');
      signal.throwIfAborted();
      const evidence = Buffer.from(
        JSON.stringify(
          candidateEvidenceSchema.parse({
            candidateHash: policy.sha256,
            snapshotHash: revision.snapshotHash,
            planHash: evidenceHash(plan),
            policyHash: state.policyHash,
            contractHash: status.contractHash,
            engine: status.engine,
            checkers: status.checkers,
            pages: previewPages,
          }),
        ),
      );
      document.candidate = {
        hash: policy.sha256,
        evidenceHash: bytesHash(evidence),
        revisionHash: revision.hash,
        planHash: evidenceHash(plan),
        snapshotHash: revision.snapshotHash,
        policyHash: state.policyHash,
        contractHash: status.contractHash,
        engine: status.engine,
        checkers: status.checkers,
        checks: mandatoryChecks.map((name) => ({ name, passed: true })),
      };
      const candidatePath = `.studio/candidates/${document.id}/${policy.sha256}.pdf`;
      const evidencePath = `.studio/evidence/${document.id}/${bytesHash(evidence)}.json`;
      const outputs = [
        {
          artifact: { path: candidatePath, documentId: document.id, role: 'candidate' as const },
          bytes,
        },
        {
          artifact: { path: evidencePath, documentId: document.id, role: 'evidence' as const },
          bytes: evidence,
        },
      ].filter(
        (output) =>
          !store
            .artifacts()
            .some(
              (artifact) =>
                artifact.path === output.artifact.path && artifact.hash === bytesHash(output.bytes),
            ),
      );
      await store.transition(request.version, state, outputs);
    } finally {
      await store.clearScratch(job.id);
    }
    return this.view();
  }
  private async candidateEvidence(state: StudioState, document: StudioDocument) {
    const status = await this.ready();
    const candidate = document.candidate;
    if (
      !candidate ||
      candidate.engine !== status.engine ||
      JSON.stringify(candidate.checkers) !== JSON.stringify(status.checkers) ||
      state.contractHash !== status.contractHash
    )
      throw new Error('VERIFICATION_FAILED');
    const gate = documentGate(state, document);
    if (!gate.ok && gate.blockers.some((blocker) => blocker.code !== 'CANDIDATE_UNREVIEWED'))
      throw new Error('VERIFICATION_FAILED');
    await this.current().validate();
    await this.artifact(document.id, 'candidate', candidate.hash);
    const evidence = candidateEvidenceSchema.parse(
      JSON.parse(
        (await this.artifact(document.id, 'evidence', candidate.evidenceHash)).bytes.toString(),
      ),
    );
    if (
      evidence.candidateHash !== candidate.hash ||
      evidence.snapshotHash !== candidate.snapshotHash ||
      evidence.planHash !== candidate.planHash ||
      evidence.policyHash !== state.policyHash ||
      evidence.contractHash !== status.contractHash ||
      evidence.engine !== status.engine ||
      JSON.stringify(evidence.checkers) !== JSON.stringify(status.checkers) ||
      evidence.pages.length !== document.revision?.pages.length
    )
      throw new Error('VERIFICATION_FAILED');
    return evidence;
  }
  async reviewCandidate(value: unknown, signal: AbortSignal): Promise<StudioView> {
    const request = requestSchema
      .extend({ candidateHash: hashSchema, page: z.number().int().nonnegative().max(7) })
      .strict()
      .parse(value);
    const store = this.current();
    const state = store.state();
    if (state.version !== request.version) throw new Error('STATE_STALE');
    const document = this.document(state, request.id);
    const candidate = document.candidate;
    if (!candidate || candidate.hash !== request.candidateHash) throw new Error('CANDIDATE_STALE');
    const evidence = await this.candidateEvidence(state, document);
    const page = evidence.pages[request.page];
    if (!page) throw new Error('Invalid candidate page');
    const isolated = session.fromPartition('studio-candidate', { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'file://*/*'] },
      (_request, callback) => callback({ cancel: true }),
    );
    isolated.protocol.handle('app', async (resourceRequest) => {
      const url = new URL(resourceRequest.url);
      if (url.hostname !== 'studio-candidate' || resourceRequest.method !== 'GET')
        return new Response('Denied', { status: 403 });
      if (url.pathname === '/page.png')
        return new Response(Buffer.from(page.png, 'base64'), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (url.pathname !== '/review.html') return new Response('Missing', { status: 404 });
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sanitized candidate page ${request.page + 1}</title><style>body{font:16px sans-serif;background:#eef2ef;padding:24px}img{display:block;max-width:100%;height:auto;background:white}p{max-width:70ch}</style><h1>Sanitized candidate — page ${request.page + 1} of ${evidence.pages.length}</h1><p>Review the actual independently rendered output, including neighboring content. Close this window when finished; you will then be asked to record your decision.</p><p>Candidate SHA-256: ${candidate.hash}</p><img src="app://studio-candidate/page.png" alt="Actual sanitized candidate page"></html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'none'; img-src app:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'",
          },
        },
      );
    });
    const preview = new BrowserWindow({
      parent: this.window,
      width: 1000,
      height: 850,
      title: `Sanitized candidate — page ${request.page + 1}`,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        devTools: false,
      },
    });
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    preview.webContents.on('will-navigate', (event) => event.preventDefault());
    const abort = () => {
      if (!preview.isDestroyed()) preview.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const closed = new Promise<void>((resolveClose) => preview.once('closed', resolveClose));
      await preview.loadURL('app://studio-candidate/review.html');
      await closed;
      signal.throwIfAborted();
      const decision = await dialog.showMessageBox(this.window, {
        type: 'question',
        buttons: ['Cancel', 'Record page review'],
        defaultId: 0,
        cancelId: 0,
        message: `Approve sanitized candidate page ${request.page + 1}?`,
        detail: `Record that you reviewed this exact output page, its mask coverage and neighboring content.\nSHA-256: ${candidate.hash}`,
      });
      if (decision.response !== 1) return this.view();
      signal.throwIfAborted();
      await this.candidateEvidence(state, document);
      const contextHash = reviewContext(state, document);
      const reviewed =
        candidate.review?.candidateHash === candidate.hash &&
        candidate.review.contextHash === contextHash
          ? candidate.review.pages
          : [];
      candidate.review = {
        candidateHash: candidate.hash,
        contextHash,
        actor: 'Local user',
        at: new Date().toISOString(),
        pages: [...new Set([...reviewed, request.page])].sort((left, right) => left - right),
      };
      await store.transition(request.version, state);
      return this.view();
    } finally {
      signal.removeEventListener('abort', abort);
      if (!preview.isDestroyed()) preview.destroy();
      isolated.protocol.unhandle('app');
      await isolated.clearStorageData();
    }
  }
  async approveRelease(value: unknown, signal: AbortSignal): Promise<StudioView> {
    const request = z
      .object({
        version: z.number().int().nonnegative(),
        selection: z.array(idSchema).min(1).max(1000),
      })
      .strict()
      .parse(value);
    const store = this.current();
    const state = store.state();
    if (state.version !== request.version) throw new Error('STATE_STALE');
    const manifest = makeReleaseManifest(state, request.selection, randomUUID());
    for (const id of request.selection)
      await this.candidateEvidence(state, this.document(state, id));
    const decision = await dialog.showMessageBox(this.window, {
      type: 'question',
      buttons: ['Cancel', 'Approve this release'],
      defaultId: 0,
      cancelId: 0,
      message: `Approve ${manifest.files.length} sanitized document(s) for sharing?`,
      detail: `Only the selected image-only PDFs and a neutral manifest will be published. Text search, accessibility tags, forms and signatures are absent. Originals remain private.\n\n${manifest.files.map((file) => `${file.name} · ${file.pages} page(s)\n${file.hash}`).join('\n\n')}\n\nManifest SHA-256: ${evidenceHash(manifest)}`,
    });
    if (decision.response !== 1) return this.view();
    signal.throwIfAborted();
    state.releaseApproval = {
      manifest,
      manifestHash: evidenceHash(manifest),
      contextHash: releaseFingerprint({ ...state, version: state.version + 1 }, request.selection),
      actor: 'Local user',
      at: new Date().toISOString(),
    };
    await store.transition(request.version, state);
    return this.view();
  }
  async publish(value: unknown, signal: AbortSignal): Promise<StudioView> {
    const request = z.object({ version: z.number().int().nonnegative() }).strict().parse(value);
    const store = this.current();
    const state = store.state();
    if (state.version !== request.version) throw new Error('STATE_STALE');
    const gate = releaseGate(state);
    if (!gate.ok) throw new Error(gate.blockers[0]?.code ?? 'RELEASE_UNAPPROVED');
    for (const file of state.releaseApproval?.manifest.files ?? [])
      await this.candidateEvidence(state, this.document(state, file.documentId));
    signal.throwIfAborted();
    await store.publish(request.version);
    return this.view();
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
  handle('apply', (value, signal) => service.apply(value, signal));
  handle('reviewCandidate', (value, signal) => service.reviewCandidate(value, signal));
  handle('approveRelease', (value, signal) => service.approveRelease(value, signal));
  handle('publish', (value, signal) => service.publish(value, signal));
  handle('cancel', async () => {});
  return async () => {
    for (const channel of names) ipcMain.removeHandler(channel);
    await service.dispose();
  };
}
