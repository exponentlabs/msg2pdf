# Verification

## Required checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit:production
pnpm package:dir
pnpm test:packaged
```

`pnpm check` runs strict TypeScript, Biome, unit tests, production bundling and real Electron integration tests. Set `MSG2PDF_TEST_OFFICE` to a supported local LibreOffice executable to include real DOCX conversion; otherwise that optional test skips explicitly.

Unit coverage includes portable/colliding filenames, unsafe paths and symlinks, atomic commits, directory locks, file discovery, email encodings, MIME/CID resources, attachment failures, malicious HTML/styles/URLs, S/MIME handling, RTF, resource limits, cancellation and release signing prerequisites. macOS Office tests check that the isolated process cannot read an unrelated file or reach a local TCP server.

Electron integration tests exercise GUI selection/planning, preview isolation, real PDF printing, attachments, history, reports, Office setup controls, terminal output/exit codes, cancellation and safe shutdown. Visual checks cover all screens and the minimum 980 × 720 window, bundled fonts, horizontal overflow and reduced-transparency preferences.

Packaged checks inspect documentation, project/dependency licence files, font assets, ASAR contents and Electron security fuses. The bundled terminal launcher must produce a real PDF without a system runtime. `pnpm package:release` additionally verifies release signatures/notarisation and creates checksums; see [distribution](distribution.md).

## Local validation — 6 November 2026

Local validation uses macOS / Apple Silicon, Node 24.22.1, pnpm 12.16.1 and Electron 45.2.3.

| Check                                | Result                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Strict TypeScript and Biome          | Passed                                                                   |
| Unit tests                           | 47 passed                                                                |
| Real Electron integration tests      | 5 passed; optional LibreOffice test skipped without a local installation |
| Production dependency advisory audit | No known vulnerabilities reported                                        |
| Missing-credential release guard     | Rejects the build before modifying generated output                      |

The previous main-branch [native CI run](https://github.com/exponentlabs/msg2pdf/actions/runs/42193195573), at commit `8333b42c1770eca826d928662ce0e1078102dd76`, passed on macOS Apple Silicon/Intel, Windows x64 and Ubuntu. This is baseline evidence; release-preparation changes require a new native run.

Native Windows and Linux CI must pass on the intended release commit before those artifacts are distributed. Signing services and notarisation require release credentials and cannot be validated with ad-hoc development builds. Windows console Ctrl+C and optional Office conversion need native platform validation.

## Development handoff — 9 November 2026

The current converter passed `pnpm check` on macOS / Apple Silicon with Node 24.18.0 and pnpm 12.16.1: 47 unit tests and 5 Electron integration tests passed; the optional LibreOffice integration test skipped. The existing macOS isolation tests needed to run outside the agent's execution sandbox. This was a source check, not a packaged-release or Fedora result.

The next development environment is **Fedora ARM64 in a desktop VM on the Mac**. Follow the [Linux development guide](linux-development.md). Record the guest's exact Fedora release and VM configuration when executing these checks:

| Target check                                                             | Handoff status                             |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| Native guest `linux/arm64` Node 24 and pinned pnpm                       | Pending in Fedora VM                       |
| Interactive `pnpm dev` and synthetic mail/PDF smoke test                 | Pending in Fedora VM                       |
| `xvfb-run -a pnpm check`                                                 | Pending in Fedora VM                       |
| `pnpm audit:production`                                                  | Pending for transferred checkout           |
| `pnpm package:dir` and `xvfb-run -a pnpm test:packaged`                  | Pending in Fedora VM                       |
| Supported LibreOffice plus real bubblewrap-isolated integration test     | Pending; optional dependency               |
| Proposed redaction engine/viewer/verifier and SQLite ARM64 compatibility | Future S03 work; dependencies not selected |

Ubuntu x64 CI and macOS ARM64 checks do not establish Linux ARM64 or Fedora/SELinux compatibility. Mark these rows passed only with executed guest results and relevant version/skip details.
