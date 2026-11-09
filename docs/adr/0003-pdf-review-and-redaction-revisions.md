# ADR 0003: Review fixed PDF revisions and save redaction plans separately

- Status: Proposed
- Date: 9 November 2026
- Scope: Review format, editing model and studio interface

## Context

Email preview currently renders sanitized HTML, while PDF output is printed separately. Marks made against that HTML could drift when pagination or layout changes. The app already normalizes email and Office files into PDFs, making a fixed PDF revision a practical shared review format.

## Decision

The studio reviews and releases PDFs. Retain native inputs privately for provenance; producing redacted native MSG/EML/Office documents is outside the initial scope. Record conversion limitations, including absent Office content such as nonprinted sheets or notes: reviewing a PDF does not establish review of every native-file component. No native original is included in a release.

Prepare a fixed review PDF, inventory its pages and hash it before marking. Existing PDFs go through inspection and the same redaction/export gates; the converter's byte-copy path does not confer readiness. Retain existing HTML preview only as an intake aid.

Save editable redaction plans outside the PDF. A mark includes document/revision ID, revision hash, page index, region geometry, reason code and origin (`manual` or `search`). Use an explicit canonical coordinate convention: unrotated page user space, recording media/crop boxes, user-unit scale and the display transform. Multi-line selections use multiple quads/regions. Screen pixels are never stored as authoritative coordinates.

Review approval binds to the PDF revision, complete plan, relevant policy and family dispositions. Applying a plan creates a separate private candidate. A final review shows the actual sanitized candidate, including neighboring text and every affected page. Changing an approved input invalidates affected candidate/review evidence; marks are not silently migrated onto regenerated pages.

The first studio interface provides:

- Case picker and the three stage queues, with document counts and explicit blockers.
- A family tree, page thumbnails, zoom, keyboard navigation and virtualized rendering.
- Rectangle marking, text selection, exact-phrase search and reviewed bulk marking.
- Redaction reasons, undo/redo during editing, autosave, and an explicit saved/error state.
- Page review progress, a deliberate “reviewed; no redactions needed” action, and candidate review.
- A release summary listing included documents, exclusions, unresolved blockers and final output names.

Search results are suggestions until accepted. Repeated words and quoted email threads still require complete review. Scan/image-only pages are labeled as having no searchable text; manual regions remain supported. OCR and automatic personal-data detection follow as separate capabilities and never silently satisfy review gates.

Prefer evaluating PDF.js for local page rendering and text selection. It describes itself as a PDF parsing/rendering platform and is Apache-2.0 licensed; selection geometry and packaging still need a spike. The viewer and content-removal engine remain separate adapters. [PDF.js project documentation](https://mozilla.github.io/pdf.js/), checked 9 November 2026.

## Alternatives and consequences

- Redacting normalized email fields before printing can help whole-field removal, but does not cover arbitrary PDFs, images or final layout. Such helpers may generate a new review revision later.
- Editing source files directly multiplies format-specific behavior and hidden-data risks.
- Fixed revisions consume disk space and require approval invalidation, but make selections reproducible.

## Acceptance evidence

- Selections hit the same content at different zooms and on rotated/cropped pages, mixed page sizes and nondefault user units.
- Reopen restores saved plans and page progress; undo/redo cannot silently change an approved revision.
- Subject/header content, inline images and repeated occurrences can be marked on the actual PDF.
- No search matches and no text layer are distinct states; every included page has a recorded review disposition.
- A reviewer sees the final candidate bytes that will be published, identified by hash.
