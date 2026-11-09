# B1 qualification continuation — Fedora ARM64

The initial [compatibility experiment](b1-fedora-arm64.md) is followed by 37 passing qualification checks using the installed Fedora verifiers. The [captured JSON evidence](evidence/b1-qualification-fedora-arm64.json) includes exact source, contract, package, tool and candidate hashes. [ADR 0009](adr/0009-fedora-raster-profile-and-verifier-distribution.md) selects the bounded initial profile and its deployment model. B1 is complete for Fedora 44 ARM64; the subsequent [production studio](studio.md) adds the B2–B8 case/review/publication gates. Other platforms remain unqualified.

QPDF now provides the independent decoded-object allowlist missing from the initial spike. The checker also validates compressed-byte consumption and reconstructs the entire permitted serialization from QPDF's independent parse, so accepted files contain neither uninterpreted objects nor bytes outside that profile. No assembler code is imported by the policy checker. Decoded RGB checks require every marked pixel to be black and every unmarked pixel to equal the captured reviewed snapshot exactly. Poppler supplies independent parse/text/attachment/render checks. Source-renderer differences are retained as diagnostics, not silently counted as equivalent appearances.

The corpus now includes image-only sources, forms/actions/tags and alternate text, XMP, clipped/fragmented text and ligature mappings, optional layers, actual previous revisions, all right-angle rotations and mixed page sizes. Adversarial policy tests also exercise unreachable objects, hidden content streams, stale-history pointers, soft masks, appended payloads, missing masks and altered neighboring pixels. Password-protected and repair-required sources, page/pixel limits, missing tools and checker timeouts fail closed. The machine-readable contract records the exact supported limits and exclusions.

Install prerequisites with `sudo dnf install qpdf poppler-utils bubblewrap util-linux`. These are system-managed native dependencies, not application-bundled libraries. At qualification time their versions were QPDF `12.3.2`, Poppler `26.01.0`, bubblewrap `0.12.0` and util-linux `2.41.6`. Native verifier processes have explicit address-space/CPU/file-size limits in addition to wall-clock and output-buffer limits. No network or unrelated user directories are mounted into the worker sandbox.

Reproduce using the original harness setup, then:

```sh
B1_NODE_HEADERS=/tmp/node-v24.18.0/include/node pnpm b1:package
# MuPDF remains a separately installed evaluation module for the historical comparison.
B1_MUPDF_MODULE=/tmp/msg2pdf-b1-mupdf/node_modules/mupdf/dist/mupdf.js \
  xvfb-run -a pnpm b1:verify
```

The selected production profile needs no MuPDF dependency. The comparison harness still runs its original six structural-removal comparisons and records their failure to establish sanitization; the 37-check qualification does not authorize that path. `releaseEnabled` remains false because this isolated harness cannot create case review or release approvals.
