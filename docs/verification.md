# Rewrite verification — 5 November 2026

Validated locally on macOS / Apple Silicon, using Node 24.22.1, pnpm 12.16.1 and Electron 45.2.3.

| Check                                                          | Result                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Frozen pnpm installation and supply-chain policy               | Passed                                                               |
| Strict TypeScript, renderer and Node configurations            | Passed                                                               |
| Biome formatting, imports, correctness and accessibility rules | Passed without diagnostics                                           |
| Unit/security tests                                            | 40 passed                                                            |
| Real Electron integration tests                                | 6 passed, including optional Office test                             |
| Production dependency advisory audit                           | No known vulnerabilities reported                                    |
| Packaged macOS archive, licences, fuses and bundled CLI        | Passed                                                               |
| Packaged CLI real email-to-PDF conversion                      | Passed without system Node/Python                                    |
| Native packaged GUI                                            | Launched; converter and Office setup controls verified; quit cleanly |
| macOS DMG and ZIP build                                        | Produced locally with ad-hoc signing                                 |

The unit suite checks portable/colliding names, unsafe output paths and symlinks, atomic commit races, locks, file discovery, legacy character encodings, MIME/CID resources, attachment failures, metadata limits, malicious HTML/styles/URLs, signed/encrypted message handling, RTF-only messages, worker timeouts and cancellation. macOS-specific checks demonstrate that the Office sandbox reads its private workspace but cannot read an unrelated file or reach a live local TCP server.

Integration tests exercise real GUI selection/planning, isolated preview, PDF printing, ordinary attachment extraction, history, reports and Office setup controls. Terminal tests verify real Letter PDFs, MSG/EML/RTF parsing in production bundles, clean JSON, corrupt-message exit codes, unchanged PDF copies, rerun skipping, signal cancellation, and closing the GUI during conversion without leaving output locks/staging files.

LibreOffice 26.8.2.2 was downloaded from its official distribution service into temporary storage and mounted read-only for the optional DOCX conversion test. Its SHA-256 matched the official download response: `9f24fe83ab1ed5c95eb3df580119f32932f713e577feeac02bf619fb00749b55`. It was not installed into Applications or bundled with msg2pdf. The production Office policy passed conversion with network isolation intact.

Run the primary checks with:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit:production
pnpm package:dir
pnpm test:packaged
```

Set `MSG2PDF_TEST_OFFICE` to a current local LibreOffice executable when running `pnpm check` to include the optional real Office conversion test. Without it, that test explicitly skips.

## Remaining release validation

### Atlas Graphite glass adoption

The subsequent visual update adopts Atlas's graphite glass surfaces, purple emphasis, orange actions and bundled Poppins fonts. Strict type checks, Biome and all 40 unit tests pass. Five Electron integration tests pass; the optional LibreOffice integration test skips without a local installation. The conversion engine is unchanged by this visual update.

Visual captures cover the empty/queued/completed converter, email preview, activity, Office setup and minimum 980 × 720 window. The minimum-size check confirms there is no horizontal workspace overflow. Font files match the Atlas reference byte-for-byte and their OFL text is included in generated notices. Package smoke checks verify the four font assets and copyright text alongside the existing bundled-runtime, ASAR, fuse and real-PDF checks.

Windows and Linux source/build/installer workflows are implemented but were not executed on this Mac. Run the configured native CI jobs before claiming those platforms are release-validated. Windows compiles the AppContainer broker with MSVC. Linux configures Chromium's sandbox on the ephemeral runner and uses Xvfb; production hosts must support the documented sandbox prerequisites. Windows console Ctrl+C needs a native terminal check in addition to the shared cancellation tests.

The local macOS build is ad-hoc signed, not Developer ID signed or notarised. Public distribution still requires release credentials and the owner's project-licence decision. Legacy Python code is inactive and excluded from the app and allowlisted source archive. The archive also excludes dependencies, environment files, caches, personal inputs and conversion outputs.
