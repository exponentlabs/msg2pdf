# B1: Fedora ARM64 packaged compatibility experiment

Date: 9 November 2026. Status: local compatibility demonstrated; B1 profile qualification remains open. This is a synthetic development harness, not a redaction product or a shareable-output guarantee.

The harness is built separately under `artifacts/b1/package/linux-arm64-unpacked`. It does not add studio commands, workers or PDF dependencies to the converter's runtime. PDF.js is pinned as a development dependency. MuPDF is installed separately for evaluation and never copied into either package. All generated PDFs, database files and screenshots are synthetic and remain under ignored `artifacts/b1/results/<run>/` directories.

## Executed environment and results

Fedora 44 Workstation ARM64, kernel `7.2.15-200.fc44.aarch64`, SELinux Enforcing, host Node `24.18.0`, pnpm `12.16.1`, packaged Electron `45.2.3` / Node `24.22.2` / SQLite `3.53.4`. The harness runs under Xvfb. Host tools: Poppler `26.01.0`, bubblewrap `0.12.0`, and a C compiler. The Linux lock adapter was compiled against SHA-256-verified official Node `24.18.0` headers and loaded by the packaged Electron runtime through Node-API.

The [recorded machine-readable evidence](evidence/b1-fedora-arm64.json) contains exact runtime versions, evaluation-contract and source hashes, candidate/package hashes, effective SQLite settings and 16 passing compatibility checks. The record describes the experiment's limits as well as its passes.

| Area                           | Executed proof                                                                                                                                                                                       | Qualification limit                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SQLite                         | Packaged `node:sqlite`; DELETE journal, FULL synchronous, integrity check; committed row survives SIGKILL, open transaction rolls back                                                               | No full case schema, migrations or backup implementation yet                                                                  |
| Linux lock                     | Packaged Node-API `flock` adapter; contention returns `CASE_BUSY`; one recovery owner among two racing reopeners; stable lock inode; symlink rejection; surviving child does not retain ownership    | Linux/local-filesystem scope; no Windows/macOS support claim                                                                  |
| Artifact durability primitives | Packaged process syncs an artifact and containing directory before its database commit                                                                                                               | Process termination only; no VM-reset/power-loss test or guarantee                                                            |
| Viewer                         | Packaged PDF.js `6.5.438` in a sandboxed renderer; bundled worker/fonts/CMaps/WASM; real DOM text selection with nonzero bounds; canonical-coordinate round trips                                    | Programmatic DOM selection is not a completed interactive review editor                                                       |
| Raster experiment              | PDF.js canvas at scale 2; masks burned into pixels; packaged pdf-lib `1.17.1` creates a fresh image-only PDF                                                                                         | Searchable text/accessibility lost; full fidelity/allowlist qualification pending                                             |
| Structural experiment          | External MuPDF `1.28.6` runs in packaged Electron's Node runtime inside bubblewrap; selected text/image regions removed with full rewrite                                                            | Removal-only experiment retains hidden text, an attachment and metadata in the hidden-data fixture; not a sanitizer           |
| Independent checks             | Packaged verifier worker invokes host Poppler inside bubblewrap: parse, text extraction, attachment listing and every-page rendering; black-mask interiors and unmarked color/image controls checked | Poppler installation is a host prerequisite; complete independent decoded-object allowlist inspection/distribution unresolved |
| Isolation and failures         | Host checkout unavailable and host loopback unreachable inside worker sandbox; no document HTTP requests; malformed output, missing checker and checker timeout rejected                             | Synthetic checks do not establish a production hostile-input sandbox or approval gate                                         |
| Package                        | Required assets present, no node_modules/MuPDF/source maps in spike ASAR; RunAsNode enabled, Node options/Node inspector/file-protocol privileges disabled, ASAR-only loading enabled                | The private harness intentionally uses a loopback Chromium debugging endpoint for automation; it must not be distributed      |

Both PDF paths pass the six initial fixtures: text, rotated/cropped page, nondefault user unit, hidden OCR/metadata/attachment, shared image reused on two pages, and zero marks. The shared-image case masks the first occurrence while retaining the unmarked second occurrence. Independent checks establish bounded mask coverage and control preservation, not general visual equivalence or an exhaustive sanitization proof.

The structural hidden-data result is an expected limitation of this removal-only adapter. Hidden OCR text outside the selected region, `private-name.txt` and the metadata canary remain in that candidate. `sanitizationQualified` is false in every structural result. Passing the removal checks cannot qualify that candidate for release.

## Reproduce locally

Use Node 24, pinned pnpm, a C compiler, verified Node headers, Xvfb, `bubblewrap` and Fedora `poppler-utils`. The normal app does not acquire these new runtime dependencies from this spike. Obtain Node headers from the official distribution and verify the downloaded archive against its published SHA-256 checksums before extraction; pass the extracted `include/node` directory below. Development-header provisioning is intentionally separate from dependency installation.

```sh
pnpm install --frozen-lockfile

# Isolated evaluation dependency; do not add MuPDF to project dependencies.
mkdir -p /tmp/msg2pdf-b1-mupdf
npm install --prefix /tmp/msg2pdf-b1-mupdf --ignore-scripts --save-exact mupdf@1.28.6

# Adjust the verified-header path for the local installation.
B1_NODE_HEADERS=/tmp/node-v24.18.0/include/node pnpm b1:package
B1_MUPDF_MODULE=/tmp/msg2pdf-b1-mupdf/node_modules/mupdf/dist/mupdf.js \
  xvfb-run -a pnpm b1:verify
```

Each run creates a new private results directory and prints its `report.json` location. A failed assertion or subprocess sets a failing exit code and report status; the runner does not convert failure into profile approval. The evaluation contract is [versioned with the harness](../scripts/b1/evaluation-contract.json). It deliberately sets `releaseEnabled: false`, separates observed runtime checks from missing qualification work, and is hashed into the evidence. Production candidate/approval invalidation is B2/B5 work, not demonstrated here.

The spike package includes the assembler's bundled dependency notices, PDF.js licence/assets notices, and the project licence. Poppler and MuPDF remain separately installed tools with their own terms; no permission to redistribute or purchase them is inferred. See [PDF.js licence](https://github.com/mozilla/pdf.js/blob/master/LICENSE), [MuPDF licensing](https://mupdf.readthedocs.io/en/latest/license.html), [Poppler project](https://poppler.freedesktop.org/) and [Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html). Runtime compatibility claims above come from the executed report rather than upstream platform claims.

## Decisions and next work

[ADR 0007](adr/0007-fedora-arm64-storage-and-lock-spike.md) selects built-in SQLite and the OS-held Linux lock approach for local B3 development, with portable interfaces and target-specific validation still required. [ADR 0008](adr/0008-pdf-adapter-compatibility-spike.md) records the PDF adapter evidence without selecting a release-enabled engine/profile.

Before closing B1, extend the independent checker to a complete decoded-object allowlist and the ADR 0004 corpus (forms/actions/tags/old revisions, complex vectors, clipped/fragmented text, malformed/encrypted inputs and fuller geometry). Record quantitative fidelity/resource limits and production worker isolation/cancellation evidence. Resolve the verifier's deployment and offline/licensing terms, then choose an export profile explicitly. Structural removal additionally needs a complete sanitizer and a distribution-compatible engine decision. A raster profile needs explicit acceptance of accessibility/search loss. None of those requirements can be waived by the passing compatibility run.

The existing converter also passed `xvfb-run -a pnpm check` (45 unit tests, 5 Electron tests; 2 macOS-specific unit skips and 1 optional Office skip) and production advisory audit. Its ordinary unpacked runtime has separate packaged checks; this experiment does not establish redaction support on any other OS.
