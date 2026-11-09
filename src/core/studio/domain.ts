import { createHash } from 'node:crypto';
import {
  type Blocker,
  type BlockerCode,
  documentSchema,
  type Gate,
  mandatoryChecks,
  type Plan,
  planSchema,
  type ReleaseManifest,
  type Revision,
  type StudioDocument,
  type StudioState,
  sha256Schema,
} from '../../shared/studio-domain';

export * from '../../shared/studio-domain';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  throw new Error('Unsupported hash value');
}
export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function reviewContext(state: StudioState, document: StudioDocument): string {
  return evidenceHash({
    source: document.sourceHash,
    revision: document.revision,
    plan: document.plan,
    policy: state.policyHash,
    contract: state.contractHash,
    families: state.families.filter((family) => family.members.includes(document.id)),
  });
}
export function validatePlan(revision: Revision, input: unknown): Plan {
  const plan = planSchema.parse(input);
  if (
    plan.revisionHash !== revision.hash ||
    new Set(plan.reviewedPages).size !== plan.reviewedPages.length
  )
    throw new Error('PLAN_STALE');
  for (const page of plan.reviewedPages)
    if (page >= revision.pages.length) throw new Error('Invalid review page');
  if (new Set(plan.marks.map((mark) => mark.id)).size !== plan.marks.length)
    throw new Error('Duplicate mark');
  for (const mark of plan.marks) {
    const page = revision.pages[mark.page];
    if (!page) throw new Error('Invalid mark page');
    const [x1, y1, x2, y2] = mark.rect;
    const [cx1, cy1, cx2, cy2] = page.cropBox;
    if (x1 < cx1 || y1 < cy1 || x2 > cx2 || y2 > cy2) throw new Error('Mark escapes crop box');
  }
  return plan;
}
export function documentGate(state: StudioState, document: StudioDocument): Gate {
  const blockers: Blocker[] = [];
  const add = (code: BlockerCode) => blockers.push({ code, documentId: document.id });
  const { revision, plan, candidate } = document;
  if (!documentSchema.safeParse(document).success) add('CASE_INTEGRITY_ERROR');
  if (!revision || document.failure) add('PREPARATION_FAILED');
  if (revision && revision.sourceHash !== document.sourceHash) add('SOURCE_CHANGED');
  if (!plan || !revision || plan.revisionHash !== revision.hash) add('PLAN_STALE');
  if (revision && plan) {
    try {
      validatePlan(revision, plan);
    } catch {
      add('PLAN_STALE');
    }
    if (revision.pages.some((_, page) => !plan.reviewedPages.includes(page)))
      add('PAGE_UNREVIEWED');
  }
  if (
    !candidate ||
    !revision ||
    !plan ||
    candidate.revisionHash !== revision.hash ||
    candidate.snapshotHash !== revision.snapshotHash ||
    candidate.planHash !== evidenceHash(plan) ||
    candidate.policyHash !== state.policyHash ||
    candidate.contractHash !== state.contractHash ||
    !sha256Schema.safeParse(candidate.snapshotHash).success ||
    !candidate.engine ||
    new Set(candidate.checkers).size < 2 ||
    mandatoryChecks.some(
      (name) => !candidate.checks.some((check) => check.name === name && check.passed),
    ) ||
    candidate.checks.some((check) => !check.passed)
  )
    add('VERIFICATION_FAILED');
  if (
    !candidate?.review ||
    candidate.review.pages.length !== revision?.pages.length ||
    !revision ||
    revision.pages.some((_, page) => !candidate.review?.pages.includes(page)) ||
    candidate.review.candidateHash !== candidate.hash ||
    candidate.review.contextHash !== reviewContext(state, document)
  )
    add('CANDIDATE_UNREVIEWED');
  return blockers.length ? { ok: false, blockers } : { ok: true };
}
export function selectionGate(
  state: StudioState,
  selection: string[],
  expectedVersion: number,
): Gate {
  const blockers: Blocker[] = [];
  if (expectedVersion !== state.version) blockers.push({ code: 'STATE_STALE' });
  if (!selection.length || new Set(selection).size !== selection.length)
    blockers.push({ code: 'CASE_INTEGRITY_ERROR' });
  for (const id of selection) {
    const document = state.documents.find((item) => item.id === id);
    if (!document) {
      blockers.push({ code: 'CASE_INTEGRITY_ERROR' });
      continue;
    }
    const result = documentGate(state, document);
    if (!result.ok) blockers.push(...result.blockers);
  }
  for (const family of state.families.filter((item) =>
    item.members.some((id) => selection.includes(id)),
  )) {
    let complete = family.inventoryComplete;
    for (const id of family.members) {
      const disposition = family.dispositions[id];
      if (selection.includes(id)) {
        if (disposition?.kind !== 'include') complete = false;
        continue;
      }
      if (disposition?.kind === 'exclude' && disposition.reason.trim()) continue;
      if (disposition?.kind === 'represented') {
        const parent = state.documents.find((item) => item.id === disposition.parentId);
        if (
          selection.includes(disposition.parentId) &&
          parent?.revision?.hash === disposition.revisionHash &&
          disposition.pages.length &&
          disposition.pages.every((page) => parent.plan?.reviewedPages.includes(page))
        )
          continue;
      }
      complete = false;
    }
    if (!complete) blockers.push({ code: 'FAMILY_UNRESOLVED' });
  }
  return blockers.length ? { ok: false, blockers } : { ok: true };
}
export function releaseFingerprint(state: StudioState, selection: string[]): string {
  return evidenceHash({
    caseId: state.id,
    version: state.version,
    policy: state.policyHash,
    contract: state.contractHash,
    selection: [...selection].sort().map((id) => {
      const document = state.documents.find((item) => item.id === id);
      return {
        id,
        candidate: document?.candidate,
        context: document ? reviewContext(state, document) : null,
      };
    }),
  });
}
export function releaseGate(state: StudioState): Gate {
  const approval = state.releaseApproval;
  if (!approval) return { ok: false, blockers: [{ code: 'RELEASE_UNAPPROVED' }] };
  const ids = approval.manifest.files.map((file) => file.documentId);
  const gate = selectionGate(state, ids, state.version);
  if (!gate.ok) return gate;
  if (
    approval.contextHash !== releaseFingerprint(state, ids) ||
    approval.manifestHash !== evidenceHash(approval.manifest) ||
    state.releases?.some(
      (release) => release.approval.manifest.releaseId === approval.manifest.releaseId,
    ) ||
    approval.manifest.files.some((file, index) => {
      const document = state.documents.find((item) => item.id === file.documentId);
      return (
        file.name !== `document-${String(index + 1).padStart(3, '0')}.pdf` ||
        file.hash !== document?.candidate?.hash ||
        file.pages !== document.revision?.pages.length
      );
    })
  )
    return { ok: false, blockers: [{ code: 'RELEASE_UNAPPROVED' }] };
  return { ok: true };
}
export function makeReleaseManifest(
  state: StudioState,
  selection: string[],
  releaseId: string,
): ReleaseManifest {
  const gate = selectionGate(state, selection, state.version);
  if (!gate.ok) throw new Error(gate.blockers[0]?.code ?? 'RELEASE_UNAPPROVED');
  return {
    schemaVersion: 1,
    releaseId,
    profile: 'fedora-raster-v1',
    files: selection.map((id, index) => {
      const document = state.documents.find((item) => item.id === id);
      if (!document?.candidate || !document.revision) throw new Error('VERIFICATION_FAILED');
      return {
        name: `document-${String(index + 1).padStart(3, '0')}.pdf`,
        documentId: id,
        hash: document.candidate.hash,
        pages: document.revision.pages.length,
      };
    }),
  };
}
