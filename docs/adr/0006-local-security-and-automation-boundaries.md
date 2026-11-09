# ADR 0006: Local security, sensitive working data and shared gate enforcement

- Status: Accepted for the initial Fedora profile
- Date: 9 November 2026
- Scope: Trust boundaries, automation and compatibility

## Context

The current app has narrow IPC, local parsing, isolated printing and optional Office sandboxing. A studio adds long-lived originals, text indexes, plans and release approvals. Its security model must cover that working data and ensure that alternate entry points cannot bypass the gated process.

## Decision

Preserve offline operation and existing renderer/worker isolation. New PDF/OCR/search processing uses capability-scoped services, bounded workloads and explicit filesystem grants. Renderer requests carry case/document/revision IDs and expected versions, not arbitrary writable paths or SQL. The main-owned transition service validates requests, checks authority and runs gate logic independently of UI button state.

Use an access-restricted, trusted local working folder. Implement POSIX permissions and an appropriate Windows access-control policy; do not assume POSIX mode flags secure a Windows folder. Treat all three stages as sensitive until a release is intentionally copied for sharing. Disk encryption is an operating-system/deployment choice for the first version; the app does not claim encrypted-at-rest case storage.

Indexes, extracted text, OCR, previews, search phrases, plans and diagnostics remain private case data. Disable content-bearing worker logs; report bounded error codes/details. Keep original paths out of global recent activity where possible; expose case labels and counts. Clear cache/rebuild and case-close behavior must be explicit. Deleting a file/cache is not a guarantee of secure erasure from SSDs, backups or synced copies.

Opening a case acquires its lock, validates schema/layout and reconciles interrupted operations. Revalidate current hashes and safe destination ancestry at consequential operations. Manual filesystem changes never constitute promotion. The threat model protects against hostile documents and accidental disclosure; it does not claim protection against a compromised OS or a malicious user with write access to the whole case.

Lock acquisition and restart recovery follow [ADR 0002](0002-durable-case-state-and-provenance.md#lock-ownership-and-recovery-entry). A stale metadata file is not ownership, and no UI/CLI command may force-release another session's lock. After restart, failed reconciliation or published-artifact validation disables sharing. PDF removal and the independent verification components follow the same bounded, no-network processing policy; an unavailable required verifier never reduces the release gate.

GUI and future studio CLI commands share the same gate service. Automation may import, prepare, search, apply plans and verify candidates, but cannot invent review approval. Release requires an explicit user action or invocation consuming recorded current approvals; there is no `--force` gate bypass. The initial single-user mode permits the same person to mark and approve; independent two-person authorization is deferred and must not be implied by actor labels.

Keep existing converter behavior available as a clearly labeled conversion operation. Its files remain unreviewed. Legacy output/report/attachment options must reject destinations inside managed case roots, including final release directories; only the case services can write those paths. Add studio commands as a separate command family rather than changing the meaning of `--all-to-pdf` or treating `converted` as `released`.

## Alternatives and consequences

- UI-only gates leave CLI/IPC bypasses. Shared policy adds service code but makes enforcement testable.
- Cloud recognition could simplify detection but changes the privacy model; no uploads or remote models are part of this direction.
- Application encryption, authenticated roles and organizational retention policies may be needed later. They require separate decisions and are not prerequisites for implementing the local review flow.

## Acceptance evidence

- Forged, stale and out-of-order IPC/CLI transitions fail even when called without the GUI.
- Legacy conversion, attachment extraction and report writes cannot target a managed working folder.
- Hostile PDFs/OCR jobs cannot access unrelated files or the network within the chosen worker sandbox.
- Synthetic sensitive text stays out of application logs, global history and public manifests.
- Case close, cancellation and restart clean/reconcile private temporary data without publishing it.
- Native packaged tests exercise working-folder access controls, locks and worker isolation on each supported OS.

## Initial implementation evidence

The bounded Fedora ARM64 implementation and local checks are documented in the [studio guide](../studio.md). Other studio platforms remain unqualified. The raster profile uses whole-line text selection, explicit inline-resource exclusions, a single local reviewer and process-termination recovery; it does not claim native-file component review, authenticated approval or VM-reset/power-loss durability.
