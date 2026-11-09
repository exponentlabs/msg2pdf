# ADR 0004: Engine boundary, content removal, sanitization and verification

- Status: Accepted for the initial Fedora profile; library/profile selected in ADR 0009
- Date: 9 November 2026
- Scope: Producing and checking shareable PDFs

## Context

The current Chromium service prints HTML; existing PDFs are copied. Neither path implements redaction. Covering content visually or saving redaction annotations is insufficient. The release gate needs evidence that the marked content was removed and hidden data was handled, while acknowledging that automated checks cannot determine whether the reviewer selected every sensitive item.

## Decision

Introduce an isolated `RedactionServices` boundary for page inspection, content removal, sanitization and output checking. Do not implement a PDF content-stream editor in application code. Keep engine bindings behind an adapter with deadlines, memory/page/pixel limits, cancellation and no document network access. Do not run hostile PDF processing in the privileged main process.

Evaluate these profiles against one synthetic adversarial corpus before selecting a production path:

| Profile            | Required behavior                                                                                                            | Tradeoff                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Structural removal | Remove intersecting text/image/vector data; sanitize hidden structures; fully rewrite and discard obsolete objects           | Preserves useful text/layout; complex object behavior needs proof              |
| Fresh raster PDF   | Render approved pages, burn marks into pixel buffers, build a new PDF containing only sanitized images and approved metadata | Simpler output allowlist; loses original text/accessibility and increases size |

A raster profile must never copy source objects, thumbnails, metadata or the original OCR layer. If searchable output is later added, generate OCR from the sanitized pixels. A structural profile must handle hidden text, shared image objects, clipping, optional layers, annotations, links, forms, embedded files, XMP/document info, tags/alternate text and previous revisions. Remove or safely rebuild affected accessibility structures; disclose any accessibility loss. Ordinary flattening or print-to-PDF alone is not an accepted implementation.

For all candidates, use fresh output bytes with full rewrite, no incremental history, no native attachments, no scripts/actions and an explicit metadata/name policy. Unsupported features must block that profile or use an explicitly selected supported profile. Password protection, parse repairs and signature invalidation require clear outcomes; never silently claim preservation of a digital signature.

## Engine selection evidence

The evaluation starts with MuPDF bindings and a commercial redaction SDK such as Apryse. No dependency or licence change is authorized merely by listing a candidate. Compare permanent removal, sanitization coverage, deterministic geometry, offline/licensing behavior, supported platforms, packaged size, accessibility, cancellation and maintainability.

- MuPDF is offered under AGPL or a commercial licence. Record a distribution-compatible choice before integration; preserve the project's licensing policy. [MuPDF licence](https://mupdf.readthedocs.io/en/latest/license.html).
- PyMuPDF documents how image redaction and object garbage collection affect retained originals. These are evaluation cases, not a reason to assume every binding behaves identically. [Redaction API details](https://pymupdf.readthedocs.io/en/latest/page.html#Page.apply_redactions).
- Apryse distinguishes redaction from hidden-data sanitization. Confirm required packages, genuinely offline operation and runtime telemetry terms for the selected deployment. [Vendor capability documentation](https://apryse.com/capabilities/redaction/enterprise-grade).

References checked 9 November 2026. Save the benchmark results, tested engine versions and the chosen save/settings profile in a follow-up selection decision.

## Verification gate

Reopen the exact candidate bytes with a separately implemented parser and renderer. Independence is mandatory for publication: invoking the removal engine in another process, or using another wrapper around the same PDF implementation, does not qualify. Never just inspect the engine's in-memory document. The checker may use separate components for structural/text inspection and rendering, but neither may rely on the removal engine to interpret the output. Record the candidate hash, checker versions and these checks:

1. Valid PDF, expected page inventory/geometry, bounded output and successful rendering of every page.
2. Selected text absent from the relevant decoded content/regions; synthetic whole-document canaries absent from all decoded structures. Unmarked duplicate text elsewhere must be treated according to its review decision, not confused with a failed local redaction.
3. Marked image/vector regions removed or burned into output pixels; no retained source assets carrying forbidden marked data. Shared-image fixtures must exercise reuse across pages.
4. Object/metadata inspection against the export profile's allowlist, including attachments, hidden OCR, accessibility text, actions and obsolete revisions. A raw byte substring check is only supplementary.
5. Visual checks for mask coverage and unintended changes outside marked regions, followed by human review of the sanitized candidate.

Unknown, failed or skipped mandatory checks block publication. Verification is evidence about the chosen marks/profile, not certification that no sensitive information remains anywhere. Checks must not copy removed text into logs or shareable manifests.

Before enabling any export profile, S03 must produce a versioned verification contract: supported inputs, removal/sanitization policy, independent checker implementations, required checks and their pass criteria. Bind its version/hash and effective engine/checker settings to verification evidence and release approvals. A changed contract invalidates dependent verification and approvals.

For structural removal, the independent checks must cover decoded text and objects, forbidden hidden structures, retained image/vector assets and rendering of every page. For fresh raster output, independently establish that the PDF contains only the profile's permitted image/page structures and metadata, no text/OCR layer or source attachments, and that every page renders with the required masks and acceptable changes outside them. The existing text-removal check is satisfied by establishing the image-only output contract, not by searching compressed bytes. Shared-image and hidden-data fixtures remain mandatory for profile qualification.

Distinguish profile-qualification fixtures from per-candidate checks. Synthetic canaries and known source assets establish capability in the fixture corpus; they are not available for every real document. Every real candidate must still pass its contract's runtime checks. Unsupported input features, unavailable checkers, parser disagreement, timeout or an indeterminate mandatory result block publication. An unavailable profile can remain an investigation tool producing private candidates, but cannot be enabled for release through a warning or override.

## Alternatives and consequences

- Drawing rectangles with `pdf-lib` is suitable for annotations, but is not accepted as a content-removal strategy.
- A single engine for editing and verification is easier to package but creates correlated failure risk.
- A restrictive first export profile can ship sooner; its fidelity, accessibility and supported-input limits must be explicit in the UI and release notes.

## Acceptance evidence

Publish a reproducible fixture/result matrix covering rotated and fragmented text, ligatures, hidden OCR, forms, shared images, vector content, annotations, embedded files, tags, old revisions and malformed inputs. Demonstrate blocked publication for failed checks and a passing candidate review/export using the packaged runtime.

The matrix must identify the removal engine and independent parser/renderer implementations and versions. Disable or kill each mandatory checker, change the verification-contract version and introduce parser disagreement; all must invalidate or block publication. Include a zero-mark sanitized export in each qualified profile.

## Initial implementation evidence

The bounded Fedora ARM64 implementation and local checks are documented in the [studio guide](../studio.md). Other studio platforms remain unqualified. The raster profile uses whole-line text selection, explicit inline-resource exclusions, a single local reviewer and process-termination recovery; it does not claim native-file component review, authenticated approval or VM-reset/power-loss durability.
