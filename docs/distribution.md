# Building and distributing

Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm package:dir`, and `pnpm test:packaged` on the target OS. `pnpm package` creates installers. `pnpm source:archive` creates an allowlisted source tarball. Review all release contents and resolve project licensing before sharing.

| OS      | Installer        | Terminal launcher                            |
| ------- | ---------------- | -------------------------------------------- |
| macOS   | DMG and ZIP      | `msg2pdf.app/Contents/Resources/bin/msg2pdf` |
| Windows | NSIS `.exe`      | `<installation>\resources\bin\msg2pdf.cmd`   |
| Linux   | AppImage and DEB | `<app directory>/resources/bin/msg2pdf`      |

The launchers use the app's runtime, so end users do not install Node/pnpm/Python. On macOS, a symlink to the launcher can be placed in a user-owned PATH directory; it resolves symlinks correctly. On Windows add its containing directory to your user PATH. The DEB usually installs under `/opt/msg2pdf`; inspect your selected installation path. For AppImage terminal use, run `./msg2pdf-…AppImage --appimage-extract`, then `./squashfs-root/resources/bin/msg2pdf …`. Keep the extracted directory intact. AppImage's GUI starts directly.

The core app is self-contained for MSG, EML and PDF copying. LibreOffice is separately installed after setup. The download button opens a fixed official HTTPS download page and never executes downloaded installers. Linux Office conversion needs bubblewrap and unprivileged user namespaces. Ubuntu security policies can disable namespaces for some binaries; configure your host's documented policy rather than turning off isolation. Windows Office isolation expects an all-users installation readable by AppContainer processes. Unsupported configurations fail with guidance.

Build Windows packages in an MSVC Developer Command Prompt. `scripts/build-native.mjs` compiles `native/windows/office-sandbox.cpp` with `/MT`, `/W4`, `/WX` and platform mitigations. Packaging refuses to omit the helper. No privileged installer service is added.

The GitHub Actions workflow runs on pushes and pull requests to `main`, with native macOS (Apple Silicon and Intel), Windows (x64) and Linux runners. It checks types, formatting/lint, unit and GUI/CLI integration tests, then builds a portable app and exercises its bundled CLI. Every push to `main` also builds macOS DMG/ZIP packages and a Windows NSIS installer. Download them from the run's `installers-macOS-ARM64`, `installers-macOS-X64` and `installers-Windows-X64` artifacts under the repository's **Actions** tab; installers are retained for 14 days. Pull requests run verification without building installers. A manual **Run workflow** with **installers** enabled also creates installers on all platforms, including Linux. Linux tests run with Xvfb and the Chromium sandbox enabled. Builds never publish GitHub Releases automatically.

## Release signing

Local builds are for review. macOS local builds receive an ad-hoc signature so changed Electron fuses remain executable; they do not have a trusted Developer ID or notarisation. For public macOS distribution, configure `CSC_LINK`/`CSC_NAME` and electron-builder's Apple Developer signing/notarisation credentials through secret environment variables following its [official signing guide](https://www.electron.build/code-signing-mac). Credentialed builds enable hardened runtime with the JIT entitlement. Do not put credentials or certificate files in this repository.

For Windows distribution, use a trusted signing certificate/service and electron-builder's [Windows signing configuration](https://www.electron.build/code-signing-win). Unsigned development installers are not a substitute for a signed release. Linux distribution should supply checksums and your project's release-signing policy. No auto-publisher or updater is configured.

Each build includes the original dependency licence texts, a versioned inventory, Electron notices and Chromium's bundled third-party notices. Rebuild inventories from the frozen lockfile before release. The generated inventory deliberately over-includes production dependencies rather than guessing which library code survived bundling/tree-shaking.

`private: true` prevents npm publication, not executable distribution. Publishing still requires the owner's licensing decision. Archived Python files and environments are excluded from both application packages and the source archive. Do not distribute the entire working folder: it can contain ignored outputs, caches, local settings and inactive GPL-dependent code.
