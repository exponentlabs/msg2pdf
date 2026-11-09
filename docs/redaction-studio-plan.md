# Redaction studio implementation plan

Status: Planned; no redaction functionality is implemented by this document.

Date: 9 November 2026.

Development handoff target: Fedora ARM64 in a desktop VM on Apple Silicon. Follow the [Linux setup and handoff guide](linux-development.md). S03 must establish Linux ARM64 support for the engine, verifier/viewer and SQLite binding in the packaged Electron runtime; current Ubuntu x64 CI is not evidence for that target.

## Product outcome

Open a local working folder, import exported mail/documents, prepare fixed PDF pages, review and mark them, then publish a verified package through **Exported → For Redaction → Redacted for sharing**. Reopen the case later with its decisions and provenance intact.

The first complete slice is a single PDF with a manual region, saved case state, sanitized candidate review and gated publication. It must demonstrate real removal and recovery. Extend that slice to email/Office inputs, attachment families, text selection and phrase search before calling it the first studio release. Build by these observable outcomes rather than a calendar estimate.

Architecture decisions are in the [ADR index](adr/README.md). Only the three-stage product direction is accepted; detailed decisions are proposed and can be refined as the working slices produce evidence.

## Existing foundation and changes

| Current area                                   | Reuse                                                        | Required change                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `src/core/engine.ts`, `planner.ts`             | Conversion services, sequential execution, limits            | Prepare private case revisions; preserve detailed outcomes; no direct studio publication            |
| `src/core/email.ts`, `html.ts`                 | MSG/EML normalization and safe HTML                          | Account for all attachments/inline items, retain family provenance, expose reviewable headers/names |
| `src/core/office.ts`                           | Sandboxed conversion                                         | Capture converter/options and explicit fidelity limitations                                         |
| `src/core/filesystem.ts`, `lock.ts`            | Safe names/paths, private staging, atomic file writes, locks | Case-wide writer lock, checked directory publication, recovery and disk budgets                     |
| `src/main/store.ts`                            | Preferences and recent activity                              | Separate durable case store; no bounded-history source of truth                                     |
| `src/main/services.ts`                         | Worker isolation and printing                                | Isolated PDF processing, rendering and verification adapters                                        |
| `src/shared`, `src/main/ipc.ts`, `src/preload` | Runtime schemas and capability-based bridge                  | Versioned case/plan/gate commands; deny generic path writes into cases                              |
| `src/renderer`                                 | Desktop shell, settings, queue patterns                      | Case lifecycle, stage queues, PDF viewer, plan editing, family/release summaries                    |
| `src/terminal`                                 | Structured output and cancellation                           | Preserve conversion mode; add gated studio commands after GUI path works                            |
| `tests`, `scripts/test-packaged.mjs`           | Synthetic fixtures and real Electron checks                  | Adversarial redaction, crash recovery and packaged engine tests                                     |

New modules should remain small: portable domain/gate logic under `src/core/studio`, schemas under `src/shared`, case persistence and worker adapters under `src/main`, and studio views under `src/renderer`. Exact file names can follow implementation needs. Core policy must remain independent of React/Electron and database bindings.

## Gate contract

Every mutation returns the new state version or typed blockers. The server-side transition service checks evidence, not a renderer-provided `approved` flag. Proposed blocker codes include `SOURCE_CHANGED`, `PREPARATION_FAILED`, `FAMILY_UNRESOLVED`, `PAGE_UNREVIEWED`, `PLAN_STALE`, `VERIFICATION_FAILED`, `CANDIDATE_UNREVIEWED` and `CASE_INTEGRITY_ERROR`.

| Transition        | Required input                                                                       | Invalidation/failure behavior                                         |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Capture source    | Validated completed copy and source metadata                                         | Never remove the external source; failed copy is not imported         |
| Prepare revision  | Tracked source hash, converter/options, inventory                                    | Errors remain visible in Exported; no review-ready claim              |
| Save plan/review  | Expected state version and exact PDF hash                                            | Stale edits rejected; changed plans invalidate dependent approvals    |
| Apply and verify  | Frozen revision/plan/policy hashes                                                   | Candidate stays private; failed/unknown required checks block release |
| Approve candidate | Exact candidate hash, page review and current family dispositions                    | Any relevant change makes approval stale                              |
| Publish selection | Frozen members, verified artifacts, approved candidate set, approved release summary | All-or-nothing new release; no force/overwrite option                 |

All included pages require a review disposition. Zero marks is valid only with explicit review and successful sanitized export. A family member can be excluded deliberately; an extraction failure cannot silently count as exclusion. Approval of a release subset never implies the entire case was reviewed.

## Work packages

All items below are planned. S01–S02 and S03 establish the foundations; they do not require a product-wide rewrite before the first slice.

| ID  | Deliverable                                   | Depends on           | Acceptance criteria                                                                                                                                                                                                    |
| --- | --------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Domain schemas and gate evaluator             | ADRs                 | Cases, sources, revisions, plans, families and releases have stable IDs; state transitions return typed blockers; stale/hash-mismatched evidence cannot pass                                                           |
| S02 | Working folder and durable store              | S01                  | Create/open/relocate a case; capture/hash one PDF; reopen without lost state; lock a second writer; detect tampering and unknown files; reject recursive intake                                                        |
| S03 | Engine/viewer/persistence compatibility spike | ADRs                 | Packaged runtime renders/selects text, applies a region, sanitizes and independently reopens adversarial samples; record licence/offline terms and tested profiles; select SQLite binding and engine in ADR follow-ups |
| S04 | Minimal PDF review editor                     | S02, S03             | Open fixed pages, mark rectangles, autosave/reopen plans, track page review, handle zoom/rotation/crop transforms, undo/redo; source bytes remain intact                                                               |
| S05 | Private candidate pipeline and verifier       | S01, S03, S04        | Apply frozen plan, fully rewrite/sanitize, run independent structural/text/render checks, retain evidence by hash, show final candidate; failures/cancellation cannot publish                                          |
| S06 | First gated publication slice                 | S02, S04, S05        | Explicit candidate and release approval; allowlisted package/neutral names; atomic promotion; kill/reopen recovery at every boundary; no unapproved files appear in final stage                                        |
| S07 | Email/Office preparation and families         | S02, S03, S06        | Import a mixed batch, preserve origins, prepare revisions, account for inline/nested attachments and failures, expose conversion limitations, require every selected family disposition                                |
| S08 | Full studio review workflow                   | S04, S06, S07        | Three stage queues, family tree, text selection, exact-phrase search, reviewed bulk marking, reasons, no-redaction review, visible blockers and release subset summary                                                 |
| S09 | Compatibility and automation                  | S06, S07, S08        | Legacy converter/report outputs cannot enter managed cases; studio CLI uses identical gates; machine-readable errors/cancellation; no review bypass; settings/history omit content                                     |
| S10 | Native release verification                   | S06–S09              | Adversarial matrix, interruption/recovery, migrations/backup, large-case limits, keyboard/accessibility and packaged offline/native isolation checks pass on supported OSes                                            |
| S11 | OCR and detection extensions                  | First studio release | Local OCR with bounded resources and page confidence; suggestions/rejections persist; OCR is never approval; sanitized-output text regeneration cannot restore source text                                             |

S03 can be investigated while S01–S02 are implemented. S07's parser inventory work can begin earlier, but family publication must use S06's gate. Implement legacy destination protection as soon as S02 creates managed folders; S09 completes its full command/report coverage. Do not ship a case workflow with an alternate write path into its final stage.

## Reviewable milestones

### M1: One PDF through the whole process

S01–S06 plus the early legacy-write guard. A user creates a case, imports a synthetic PDF, marks one region, reviews the actual candidate and publishes it. Close/reopen and forced interruptions preserve gate correctness. A synthetic secret cannot be recovered from the output using independent text/object inspection. Include an image-region example as well as text before claiming the chosen profile supports both.

This is the earliest useful demo. It is a constrained vertical slice, not evidence of arbitrary-file support.

### M2: Email/document studio

S07–S09. A mixed MSG/EML/PDF/Office case has page review, text/phrase marking, family exclusions and a deliberately selected release. Unsupported/encrypted/malformed content stays blocked or is explicitly excluded with the right scope. A no-redaction document passes the same review/sanitization gate. The existing converter remains available and its outputs are clearly unreviewed.

### M3: Supported release

S10 and a recorded engine/profile decision. Supported formats/features and export limitations match the executed fixture/native test matrix. Documentation explains backup, sensitive working data, recovery, old releases, signature changes and output accessibility. No mandatory skipped checks are counted as passing evidence.

## Verification plan

Use synthetic data only. Keep the mandatory test corpus versioned and small enough for routine CI; use larger generated workloads for resource testing.

| Layer                        | Required scenarios                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate/domain tests            | All legal/illegal transitions, stale hashes/versions, no marks, changed membership/policy, explicit exclusions, unresolved attachment inventory                                                                                                                                               |
| Filesystem/store integration | Symlinks/junctions, traversal, names/case collisions, disk full, cancelled intake, competing writers, changed files, local folder relocation, backup/restore and schema mismatch                                                                                                              |
| Crash injection              | Before/after artifact write, prepared intent, package promotion and final state commit; reconcile or block without approving unknown bytes                                                                                                                                                    |
| PDF corpus                   | Rotated/cropped pages, nondefault units, multi-line/fragmented text, ligatures, repeated phrases, hidden OCR, image-only pages, shared image reuse, vector paths, clipped/hidden text, forms, tags/alternate text, attachments, metadata, old revisions and damaged/password-protected inputs |
| Family corpus                | Nested email, inline image, signature item, duplicate content with distinct parents, unsupported archive, unreadable attachment and parent attachment-title leakage                                                                                                                           |
| GUI/IPC                      | Save/reopen/undo, keyboard marking, page progress, candidate review, forged approval calls, stale selections and explicit release subsets                                                                                                                                                     |
| CLI/compatibility            | Same blockers as GUI, stable JSON, cancellation, legacy output/report destination protection and no bypass flags                                                                                                                                                                              |
| Packaged/native              | Engine/checker assets bundled, no remote fetch/license surprise, process/network/file isolation, locks/permissions and working folder publication on each supported OS                                                                                                                        |

A text-search pass alone is insufficient. Test removal of embedded image data and hidden structures, and verify that unmarked neighboring content remains usable. Human review addresses what to remove; machine verification addresses whether the selected removal and export profile were applied.

For code changes, run `pnpm check` and the new targeted suites. Before a supported release, run `pnpm audit:production`, packaged checks and native CI as described in [verification](verification.md) and [distribution](distribution.md). Record exact versions/results; this plan makes no new validation claim.

## Decisions to resolve during the first slice

| Decision                 | Recommendation                                                         | Evidence needed                                                                          |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Engine and licence       | Evaluate mature removal engine behind an adapter                       | Adversarial results, compatible distribution terms, offline runtime and native packaging |
| Initial export profile   | Choose one explicit supported profile after comparison                 | Removal/sanitization correctness, readable fidelity, size and accessibility tradeoffs    |
| Case persistence binding | SQLite with artifact files                                             | Packaged Electron compatibility, backup/migration/recovery behavior                      |
| Viewer                   | Evaluate PDF.js                                                        | Selection geometry and transforms agree with engine; sandbox/CSP and package checks pass |
| Review authority         | Single local user with explicit approval                               | Honest attribution labels; gate cannot be synthesized through generic IPC                |
| Supported first formats  | PDF plus existing email/Office conversion; explicit blockers elsewhere | Page/family inventories and fidelity limitations can be surfaced correctly               |

## Deferred scope

Local OCR and personal-data suggestions follow the complete manual/search workflow. Redacted native-file output, cloud processing, collaborative cases, authenticated multi-reviewer approval, application-managed encryption, network/synced working folders, archive expansion, pseudonymization and organizational retention policies need separate decisions. None should block building the first complete gated PDF slice.
