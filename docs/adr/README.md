# Redaction studio architecture decisions

These records describe the planned evolution of msg2pdf into a local redaction studio. They do not describe features already implemented. The existing converter remains the current product.

The product direction is a working folder with a gated flow:

**Exported → For Redaction → Redacted for sharing**

| ADR                                                      | Decision                                                           | Status                                |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| [0001](0001-managed-working-folder-and-gates.md)         | Managed working folder and explicit promotion gates                | Accepted: product direction           |
| [0002](0002-durable-case-state-and-provenance.md)        | Durable case state, revision provenance and recovery               | Proposed                              |
| [0003](0003-pdf-review-and-redaction-revisions.md)       | Review fixed PDF revisions and save redaction plans separately     | Proposed                              |
| [0004](0004-redaction-engine-and-output-verification.md) | Engine boundary, content removal, sanitization and verification    | Proposed; engine selection open       |
| [0005](0005-document-families-and-release-packages.md)   | Attachment families and immutable release packages                 | Proposed                              |
| [0006](0006-local-security-and-automation-boundaries.md) | Local security, sensitive working data and shared gate enforcement | Proposed                              |
| [0007](0007-fedora-arm64-storage-and-lock-spike.md)      | Fedora ARM64 packaged SQLite and OS-lock adapter evidence          | Accepted for local development        |
| [0008](0008-pdf-adapter-compatibility-spike.md)          | Packaged PDF adapter evidence and remaining profile qualification  | Proposed; no release profile selected |

Accepted means the direction is agreed, not that implementation or verification is complete. Proposed records are concrete design recommendations to refine during implementation; they do not require a separate approval ceremony before ordinary development. Update a record's status when its decision is settled. Supersede decisions with a linked record when their rationale changes.

Each record includes context, a decision, alternatives and acceptance evidence. Track executable work in the [implementation plan](../redaction-studio-plan.md), rather than using ADRs as a task checklist.

Created: 9 November 2026.

The initial Fedora profile and verifier distribution are now selected in [ADR 0009](0009-fedora-raster-profile-and-verifier-distribution.md), with [qualification evidence](../b1-qualification.md). ADR 0008 remains the historical compatibility evaluation; its open Fedora raster-profile decision is resolved by ADR 0009. Other native targets remain unqualified.
