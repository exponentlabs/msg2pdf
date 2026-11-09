import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  documentGate,
  evidenceHash,
  makeReleaseManifest,
  mandatoryChecks,
  releaseFingerprint,
  releaseGate,
  reviewContext,
  type StudioDocument,
  type StudioState,
  selectionGate,
  studioStateSchema,
  validatePlan,
} from '../../src/core/studio/domain';

function ready() {
  const sourceHash = evidenceHash('captured source');
  const pdfHash = evidenceHash('fixed PDF');
  const document: StudioDocument = {
    id: randomUUID(),
    sourceHash,
    revision: {
      hash: pdfHash,
      snapshotHash: evidenceHash('reviewed RGB'),
      sourceHash,
      converter: 'fixture',
      pages: Array.from({ length: 2 }, () => ({
        mediaBox: [0, 0, 400, 400],
        cropBox: [20, 20, 380, 380],
        rotation: 0,
        userUnit: 1,
      })),
    },
    plan: { id: randomUUID(), revisionHash: pdfHash, marks: [], reviewedPages: [0, 1] },
  };
  const state: StudioState = {
    schemaVersion: 1,
    id: randomUUID(),
    version: 4,
    policyHash: evidenceHash('policy'),
    contractHash: evidenceHash('contract'),
    documents: [document],
    families: [],
  };
  document.candidate = {
    hash: evidenceHash('candidate bytes'),
    evidenceHash: evidenceHash('verification evidence'),
    revisionHash: pdfHash,
    planHash: evidenceHash(document.plan),
    policyHash: state.policyHash,
    contractHash: state.contractHash,
    snapshotHash: evidenceHash('reviewed RGB'),
    engine: 'PDF.js plus fresh raster assembler',
    checkers: ['QPDF 12.3.2', 'Poppler 26.01.0'],
    checks: mandatoryChecks.map((name) => ({ name, passed: true })),
  };
  const seal = () => {
    if (!document.candidate) throw new Error('No candidate');
    document.candidate.review = {
      candidateHash: document.candidate.hash,
      contextHash: reviewContext(state, document),
      actor: 'Local reviewer',
      at: '2026-11-09T00:00:00.000Z',
      pages: [0, 1],
    };
  };
  seal();
  return { state, document, seal };
}

describe('studio publication gates', () => {
  it('binds release approval to the exact version, manifest and candidate selection', () => {
    const { state, document } = ready();
    const manifest = makeReleaseManifest(state, [document.id], randomUUID());
    state.releaseApproval = {
      manifest,
      manifestHash: evidenceHash(manifest),
      contextHash: releaseFingerprint(state, [document.id]),
      actor: 'Local user',
      at: new Date().toISOString(),
    };
    expect(releaseGate(state)).toEqual({ ok: true });
    state.version++;
    expect(releaseGate(state)).toMatchObject({ ok: false });
    state.version--;
    const first = manifest.files[0];
    if (!first) throw new Error('Missing manifest file');
    first.name = 'document-999.pdf';
    state.releaseApproval.manifestHash = evidenceHash(manifest);
    expect(releaseGate(state)).toMatchObject({ ok: false });
  });
  it('allows an explicitly reviewed zero-mark sanitized candidate', () => {
    const { state, document } = ready();
    expect(studioStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(documentGate(state, document)).toEqual({ ok: true });
    expect(selectionGate(state, [document.id], state.version)).toEqual({ ok: true });
  });
  it('does not interpret zero marks as page review or candidate approval', () => {
    const { state, document } = ready();
    if (!document.plan || !document.candidate) throw new Error('Invalid fixture');
    document.plan.reviewedPages = [0];
    document.candidate.review = undefined;
    expect(documentGate(state, document)).toMatchObject({
      ok: false,
      blockers: expect.arrayContaining([
        { code: 'PAGE_UNREVIEWED', documentId: document.id },
        { code: 'CANDIDATE_UNREVIEWED', documentId: document.id },
      ]),
    });
  });
  it.each(['policy', 'contract', 'source', 'revision', 'plan', 'bytes'] as const)(
    'invalidates evidence after %s changes',
    (change) => {
      const { state, document } = ready();
      if (!document.revision || !document.plan || !document.candidate)
        throw new Error('Invalid fixture');
      const fingerprint = releaseFingerprint(state, [document.id]);
      if (change === 'policy') state.policyHash = evidenceHash('new policy');
      if (change === 'contract') state.contractHash = evidenceHash('new checker contract');
      if (change === 'source') document.sourceHash = evidenceHash('changed source');
      if (change === 'revision') document.revision.hash = evidenceHash('regenerated PDF');
      if (change === 'plan')
        document.plan.marks.push({
          id: randomUUID(),
          page: 0,
          rect: [20, 20, 100, 100],
          reason: 'Private',
          origin: 'manual',
        });
      if (change === 'bytes') document.candidate.hash = evidenceHash('different candidate');
      expect(documentGate(state, document).ok).toBe(false);
      expect(releaseFingerprint(state, [document.id])).not.toBe(fingerprint);
    },
  );
  it('rejects missing, failed or correlated verification evidence', () => {
    for (const mode of ['missing', 'failed', 'correlated']) {
      const { state, document } = ready();
      if (!document.candidate) throw new Error('Invalid fixture');
      if (mode === 'missing') document.candidate.checks.pop();
      if (mode === 'failed')
        document.candidate.checks.push({ name: 'additional mandatory check', passed: false });
      if (mode === 'correlated') document.candidate.checkers = ['same-engine', 'same-engine'];
      expect(documentGate(state, document)).toMatchObject({
        ok: false,
        blockers: expect.arrayContaining([
          { code: 'VERIFICATION_FAILED', documentId: document.id },
        ]),
      });
    }
  });
  it('rejects stale, empty, duplicate and unknown release selections', () => {
    const { state, document } = ready();
    expect(selectionGate(state, [document.id], state.version - 1)).toMatchObject({
      ok: false,
      blockers: [{ code: 'STATE_STALE' }],
    });
    for (const selection of [[], [document.id, document.id], [randomUUID()]])
      expect(selectionGate(state, selection, state.version).ok).toBe(false);
  });
  it('requires accountable family dispositions and invalidates approval when exclusions change', () => {
    const { state, document, seal } = ready();
    const child: StudioDocument = { id: randomUUID(), sourceHash: evidenceHash('attachment') };
    state.documents.push(child);
    const family = {
      id: randomUUID(),
      members: [document.id, child.id],
      inventoryComplete: false,
      dispositions: {
        [document.id]: { kind: 'include' as const },
        [child.id]: { kind: 'unresolved' as const },
      },
    };
    state.families.push(family);
    seal();
    expect(selectionGate(state, [document.id], state.version).ok).toBe(false);
    const stored = state.families[0];
    if (!stored) throw new Error('Invalid fixture');
    stored.inventoryComplete = true;
    stored.dispositions[child.id] = { kind: 'exclude', reason: 'Outside release scope' };
    seal();
    expect(selectionGate(state, [document.id], state.version)).toEqual({ ok: true });
    stored.dispositions[child.id] = { kind: 'exclude', reason: 'Changed scope' };
    expect(documentGate(state, document).ok).toBe(false);
  });
  it('rejects invalid geometry, duplicate marks and a stale plan revision', () => {
    const { document } = ready();
    if (!document.plan || !document.revision) throw new Error('Invalid fixture');
    const mark = {
      id: randomUUID(),
      page: 0,
      rect: [0, 0, 100, 100],
      reason: 'Private',
      origin: 'manual',
    };
    expect(() =>
      validatePlan(document.revision as NonNullable<typeof document.revision>, {
        ...document.plan,
        marks: [mark],
      }),
    ).toThrow('crop');
    expect(() =>
      validatePlan(document.revision as NonNullable<typeof document.revision>, {
        ...document.plan,
        revisionHash: evidenceHash('stale'),
      }),
    ).toThrow('PLAN_STALE');
    expect(() =>
      validatePlan(document.revision as NonNullable<typeof document.revision>, {
        ...document.plan,
        reviewedPages: [0, 0],
      }),
    ).toThrow('PLAN_STALE');
  });
  it('rejects unknown fields, duplicate identities and forged inventory references at persistence boundaries', () => {
    const { state, document } = ready();
    expect(studioStateSchema.safeParse({ ...state, approved: true }).success).toBe(false);
    expect(studioStateSchema.safeParse({ ...state, documents: [document, document] }).success).toBe(
      false,
    );
    expect(
      studioStateSchema.safeParse({
        ...state,
        families: [
          { id: randomUUID(), members: [randomUUID()], inventoryComplete: true, dispositions: {} },
        ],
      }).success,
    ).toBe(false);
  });
  it('hashes object keys deterministically and refuses non-finite evidence', () => {
    expect(evidenceHash({ b: [2, 3], a: 1 })).toBe(evidenceHash({ a: 1, b: [2, 3] }));
    expect(() => evidenceHash({ invalid: Number.NaN })).toThrow();
  });
});
