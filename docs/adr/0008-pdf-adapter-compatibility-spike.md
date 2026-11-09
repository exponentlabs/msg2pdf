# ADR 0008: PDF adapter compatibility evidence and profile qualification

- Status: Proposed; local compatibility demonstrated, no release profile selected
- Date: 9 November 2026
- Scope: S03/B1 engine, viewer and independent verifier evidence; refines ADRs 0003–0004

## Context

The first studio slice needs page rendering/selection, content removal and independent verification in the packaged ARM64 runtime. The [B1 experiment](../b1-fedora-arm64.md) exercises two processing paths on six synthetic fixtures and records their actual limitations.

## Decision

Continue evaluating PDF.js `6.5.438` for the sandboxed viewer. The local package demonstrates its worker/assets, page rendering, DOM text selection and canonical-coordinate round trips for cropped/rotated pages and nondefault user units. This is sufficient to proceed with viewer interfaces, not to claim a finished review editor or general selection accuracy.

Keep PDF.js rendering plus fresh pdf-lib image-only assembly as the candidate raster path. Its saved outputs pass independent Poppler parsing/rendering, empty text-layer, attachment absence and mask/control checks in the initial corpus. It loses original searchable text and accessibility, as expected. Full independent object-allowlist, fidelity and adversarial qualification remain mandatory before selecting this profile.

Keep MuPDF `1.28.6` outside project dependencies and packages as an isolated structural-removal experiment. It removes the chosen text/image regions in the fixture matrix, but this adapter does not sanitize hidden OCR text, attachments or metadata outside those regions. It cannot be the publication implementation in this form. The package declares `AGPL-3.0-or-later`; no commercial licence or distribution-licence change is selected or purchased by this spike. Any integration needs the explicit compatible distribution decision already required by ADR 0004.

Use host Poppler `26.01.0` as the independent local checker in this experiment. A packaged Node worker invokes its tools inside bubblewrap, with independent every-page rendering, text extraction and attachment inventory. Its PDF implementation is separate from both PDF.js and MuPDF. Supplemental pdf-lib object inspection shares the raster assembler's implementation and must not be represented as independent allowlist verification. Poppler deployment/bundling and full runtime check coverage remain unresolved.

The [evaluation contract](../../scripts/b1/evaluation-contract.json) stays versioned and hashed into reports with `releaseEnabled: false`. No fixture result grants review approval or enables publication. The private harness has a loopback Chromium debugging endpoint for automation and must not be shipped as the studio.

## Alternatives and consequences

- Structural removal preserves useful text but needs a separate sanitization implementation, broader evidence and a resolved engine licence.
- Fresh raster output has a simpler output model but still needs an independent decoded-object allowlist, quantitative fidelity limits, resource bounds and a clear accessibility/search tradeoff.
- Poppler is a working local independent implementation; host installation does not establish an offline cross-platform distribution strategy.
- A commercial SDK remains an alternative if evidence or distribution requirements rule out the evaluated paths. This experiment does not establish that vendor's terms or ARM64 compatibility.

## Acceptance evidence and next decision

The [recorded report](../evidence/b1-fedora-arm64.json) includes candidate/package hashes, exact versions, 16 passing compatibility checks and the observed unsanitized structural candidate. Both paths handle the initial selected regions and preserve the unmarked shared-image occurrence; malformed output, a missing checker and checker timeout fail. These are compatibility findings, not complete ADR 0004 qualification.

Before accepting an engine/profile decision, complete the missing qualification/deployment items in the evaluation contract and B1 report. Select the profile, supported features, mandatory independent checks and offline/distribution arrangement in a follow-up decision, with no warning-based release override. Keep B1 open for that work while B2 and the proven Fedora storage adapter can proceed.
