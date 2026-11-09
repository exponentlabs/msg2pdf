import { z } from 'zod';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const boxSchema = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(([x1, y1, x2, y2]) => x2 > x1 && y2 > y1, 'Invalid page rectangle');
export const pageSchema = z
  .object({
    mediaBox: boxSchema,
    cropBox: boxSchema,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    userUnit: z.number().positive().max(100),
  })
  .strict();
export const markSchema = z
  .object({
    id: z.string().uuid(),
    page: z.number().int().nonnegative().max(9999),
    rect: boxSchema,
    reason: z.string().trim().min(1).max(200),
    origin: z.enum(['manual', 'search']),
  })
  .strict();
export const planSchema = z
  .object({
    id: z.string().uuid(),
    revisionHash: sha256Schema,
    marks: z.array(markSchema).max(10_000),
    reviewedPages: z.array(z.number().int().nonnegative()).max(10_000),
  })
  .strict();
export type ReviewPage = z.infer<typeof pageSchema>;
export type Plan = z.infer<typeof planSchema>;
export interface Revision {
  hash: string;
  snapshotHash: string;
  sourceHash: string;
  pages: ReviewPage[];
  converter: string;
}
export const mandatoryChecks = [
  'object-allowlist',
  'decoded-pixel-preservation',
  'independent-render',
  'content-sanitization',
] as const;
export interface Candidate {
  hash: string;
  revisionHash: string;
  planHash: string;
  policyHash: string;
  contractHash: string;
  snapshotHash: string;
  engine: string;
  checkers: string[];
  checks: { name: string; passed: boolean }[];
  review?: { candidateHash: string; contextHash: string; actor: string; at: string } | undefined;
}
export interface StudioDocument {
  id: string;
  sourceHash: string;
  revision?: Revision | undefined;
  plan?: Plan | undefined;
  candidate?: Candidate | undefined;
  failure?: string | undefined;
}
export type Disposition =
  | { kind: 'include' }
  | { kind: 'exclude'; reason: string }
  | { kind: 'represented'; parentId: string; revisionHash: string; pages: number[] }
  | { kind: 'unresolved' };
export interface Family {
  id: string;
  members: string[];
  inventoryComplete: boolean;
  dispositions: Record<string, Disposition>;
}
export interface StudioState {
  schemaVersion: 1;
  id: string;
  version: number;
  policyHash: string;
  contractHash: string;
  documents: StudioDocument[];
  families: Family[];
}
const reviewSchema = z
  .object({
    candidateHash: sha256Schema,
    contextHash: sha256Schema,
    actor: z.string().min(1).max(100),
    at: z.string().datetime(),
  })
  .strict();
export const candidateSchema: z.ZodType<Candidate> = z
  .object({
    hash: sha256Schema,
    revisionHash: sha256Schema,
    planHash: sha256Schema,
    policyHash: sha256Schema,
    contractHash: sha256Schema,
    snapshotHash: sha256Schema,
    engine: z.string().min(1).max(200),
    checkers: z.array(z.string().min(1).max(200)).min(2).max(10),
    checks: z
      .array(z.object({ name: z.string().min(1).max(100), passed: z.boolean() }).strict())
      .max(20),
    review: reviewSchema.optional(),
  })
  .strict();
export const revisionSchema: z.ZodType<Revision> = z
  .object({
    hash: sha256Schema,
    snapshotHash: sha256Schema,
    sourceHash: sha256Schema,
    pages: z.array(pageSchema).min(1).max(8),
    converter: z.string().min(1).max(200),
  })
  .strict();
export const documentSchema: z.ZodType<StudioDocument> = z
  .object({
    id: z.string().uuid(),
    sourceHash: sha256Schema,
    revision: revisionSchema.optional(),
    plan: planSchema.optional(),
    candidate: candidateSchema.optional(),
    failure: z.string().min(1).max(100).optional(),
  })
  .strict();
const dispositionSchema: z.ZodType<Disposition> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('include') }).strict(),
  z.object({ kind: z.literal('exclude'), reason: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('unresolved') }).strict(),
  z
    .object({
      kind: z.literal('represented'),
      parentId: z.string().uuid(),
      revisionHash: sha256Schema,
      pages: z.array(z.number().int().nonnegative()).min(1).max(8),
    })
    .strict(),
]);
export const studioStateSchema: z.ZodType<StudioState> = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    policyHash: sha256Schema,
    contractHash: sha256Schema,
    documents: z.array(documentSchema).max(1000),
    families: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            members: z.array(z.string().uuid()).min(1).max(1000),
            inventoryComplete: z.boolean(),
            dispositions: z.record(z.string(), dispositionSchema),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = state.documents.map((document) => document.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Duplicate document identity' });
    const familyIds = state.families.map((family) => family.id);
    if (new Set(familyIds).size !== familyIds.length)
      context.addIssue({ code: 'custom', message: 'Duplicate family identity' });
    for (const family of state.families)
      if (
        new Set(family.members).size !== family.members.length ||
        family.members.some((id) => !ids.includes(id)) ||
        Object.keys(family.dispositions).some((id) => !family.members.includes(id))
      )
        context.addIssue({ code: 'custom', message: 'Invalid family inventory' });
  });
export type BlockerCode =
  | 'STATE_STALE'
  | 'SOURCE_CHANGED'
  | 'PREPARATION_FAILED'
  | 'PAGE_UNREVIEWED'
  | 'PLAN_STALE'
  | 'FAMILY_UNRESOLVED'
  | 'VERIFICATION_FAILED'
  | 'CANDIDATE_UNREVIEWED'
  | 'CASE_INTEGRITY_ERROR'
  | 'RELEASE_UNAPPROVED'
  | 'CASE_BUSY'
  | 'CASE_LOCK_UNAVAILABLE';
export interface Blocker {
  code: BlockerCode;
  documentId?: string;
}
export type Gate = { ok: true } | { ok: false; blockers: Blocker[] };
