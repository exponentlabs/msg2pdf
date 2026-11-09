# ADR 0001: Managed working folder and explicit promotion gates

- Status: Accepted for the three-stage product direction; folder mechanics and gates proposed
- Date: 9 November 2026
- Scope: Case lifecycle and filesystem layout

## Context

The current app converts a batch into an output directory. Its `converted`, `copied` and `partial` results describe conversion outcomes, not whether a document has been reviewed or is ready to disclose. The studio needs a persistent working folder and an explicit process: **Exported → For Redaction → Redacted for sharing**.

## Decision

A working folder represents one case. The app creates and manages this layout:

```text
<working folder>/
  Exported/
    <intake-id>/<document-id>/source.<ext>
  For Redaction/
    <document-id>/<revision-id>/review.pdf
  Redacted for sharing/
    <release-id>/
      <neutral-document-id>.pdf
      manifest.json
  .studio/
    case.sqlite
    plans/
    candidates/
    staging/
    cache/
    locks/
```

The three visible names are fixed. Internal paths use stable opaque IDs; original names and source paths live in private case state. `.studio` is sensitive working data, and hiding its name provides no access control. Its layout is versioned implementation detail.

Intake copies selected files into `Exported` after validating and hashing them. External sources remain unchanged. A pre-existing export directory can be selected as an import source; simply pointing the app at a folder does not adopt every file as trusted case state. Opening an existing managed case is a separate operation.

Promotion advances a document through tracked revisions. It creates a derivative and preserves the earlier bytes; it does not destructively move the only source copy. App-owned originals and revisions are never overwritten by normal editing. External edits are detected by hash checks, not prevented by an immutability claim.

| Gate                  | Required evidence                                                                                                                           | Result                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Admit into Exported   | Complete private copy, stable captured-byte hash, recorded origin, limits/path checks                                                       | Tracked source; still unreviewed     |
| Prepare for redaction | Valid supported PDF revision, page inventory, conversion outcome, complete attachment inventory or explicit blocker                         | Reviewable revision in For Redaction |
| Publish for sharing   | Frozen selection and family dispositions, current review decisions, verified sanitized candidates, final candidate review, release approval | Complete new release package         |

Internal states distinguish `imported`, `preparing`, `needs-review`, `applying`, `awaiting-release`, `released`, `blocked` and `excluded`. Conversion failure, unreviewed content and deliberate exclusion must remain distinguishable. A file's location never establishes approval.

Gate checks run in the application service using durable state and current artifact hashes. A document with no redactions still needs an explicit review decision and a sanitized, verified export. Regenerating pages, changing marks, changing relevant policy or changing release membership invalidates dependent evidence.

Publication writes a complete package privately and promotes it to a new release directory only after every selected item passes. There is no partial successful release. A user can deliberately create a smaller release with recorded exclusions. Preparation of other documents can continue after an individual conversion failure.

## Alternatives and consequences

- Destructive moves make the folders intuitive but lose the source/revision chain. Retained derivatives cost more disk and permit reliable rework.
- Inferring status from folder membership permits manual gate bypass. The manifest and case state remain authoritative; unknown files are flagged and never silently adopted.
- A generic queue is simpler but cannot communicate persistent readiness. The studio adds case reopening and per-document blockers.

## Acceptance evidence

- A real case survives close/reopen with its three stages and pending work intact.
- Copying an arbitrary file into the final folder does not make it a released artifact.
- Failed, cancelled or interrupted preparation never creates a shareable package.
- Existing release bytes remain unchanged when a document is edited and released again.
- Importing the working folder into itself or recursively ingesting its derivatives is rejected.

Related: [state and recovery](0002-durable-case-state-and-provenance.md), [release packages](0005-document-families-and-release-packages.md).
