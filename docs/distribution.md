# Building and distributing

## Development builds

Use Node 24 LTS and the pnpm version pinned in `package.json`. Install with `pnpm install --frozen-lockfile` and run `pnpm check` before packaging.

Build on each target OS. On Windows, use an MSVC Developer Command Prompt with the C++ tools and Windows SDK installed. Linux needs GTK 3, NSS, ALSA and Xvfb for headless tests; Office conversion also needs bubblewrap. The CI workflow installs these prerequisites on native runners.

```sh
pnpm package:dir
pnpm test:packaged
pnpm package
pnpm source:archive
```

These commands write development artifacts to `release/`. macOS development builds use an ad-hoc signature; Windows development builds are unsigned unless signing credentials are supplied. Neither is a trusted public release. Installers never publish automatically.

| OS      | Installer        | Terminal launcher                            |
| ------- | ---------------- | -------------------------------------------- |
| macOS   | DMG and ZIP      | `msg2pdf.app/Contents/Resources/bin/msg2pdf` |
| Windows | NSIS `.exe`      | `<installation>\resources\bin\msg2pdf.cmd`   |
| Linux   | AppImage and DEB | `<app directory>/resources/bin/msg2pdf`      |

End users do not install Node or pnpm. The DEB normally installs under `/opt/msg2pdf`. To use an AppImage's terminal launcher, run `./msg2pdf-…AppImage --appimage-extract`, then invoke `./squashfs-root/resources/bin/msg2pdf`. Keep that extracted directory intact.

The Windows build compiles `native/windows/office-sandbox.cpp` with MSVC and packages the statically linked helper. Packaging fails if the helper is missing. Linux hosts must support the documented Chromium and Office sandbox prerequisites; do not disable isolation to work around unsupported configurations. See [usage](usage.md).

## Release preparation

Run on a clean checkout of the intended release commit:

```sh
pnpm check
pnpm audit:production
pnpm package:release
```

`package:release` checks signing prerequisites before building, writes to a separate `release/public/` directory, tests the packaged runtime, verifies platform signatures, creates an allowlisted source archive and generates `SHA256SUMS`. It replaces generated contents of that directory. It does not publish files or change repository visibility. A failed check must be resolved before distributing its output.

### macOS signing and notarisation

Provide a Developer ID certificate through `CSC_LINK` and `CSC_KEY_PASSWORD`, or use `CSC_NAME` for an installed Developer ID identity. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarisation. Use secret environment variables or CI secrets; never commit credentials or certificates.

Release builds require signing, enable hardened runtime with the JIT entitlement and submit the app for notarisation. The release command validates the signature, stapled notarisation ticket and Gatekeeper assessment. See [electron-builder's macOS signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

### Windows signing

For Azure Artifact Signing (called Trusted Signing in the pinned packager), set `WIN_SIGNING_PROVIDER=azure` and configure:

- `AZURE_SIGNING_ENDPOINT`: the signing service's HTTPS endpoint.
- `AZURE_SIGNING_ACCOUNT_NAME` and `AZURE_SIGNING_CERTIFICATE_PROFILE_NAME`.
- `WIN_PUBLISHER_NAME`: the certificate's exact publisher common name.
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`: credentials for an identity authorised to sign with that certificate profile.

Alternatively, use `WIN_SIGNING_PROVIDER=certificate` with `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for an existing compatible certificate setup. Use a CA-supported signing method and protect its keys. The release command requires valid timestamped signatures on the app, Office helper and installer. Signing establishes publisher identity; SmartScreen reputation can still produce warnings for a new release. See [Microsoft's guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) and the [pinned packager's configuration](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

### Linux

Linux releases include checksums, AppImage and DEB packages. Publish these through a trusted distribution channel. Checksums detect changes against a trusted manifest; they do not establish publisher identity by themselves. Repository/package signing can be added if distributing through a package repository.

## CI

**Verify and package** runs native macOS, Windows and Linux checks for pushes/pull requests to `main`. Pushes to `main` build macOS Apple Silicon/Intel and Windows x64 development installers. A manual run with **installers** enabled also packages Linux. Download `installers-*` artifacts from [Actions](https://github.com/exponentlabs/msg2pdf/actions); they are retained for 14 days.

**Prepare release** is a manual workflow restricted to `main`. Configure the signing secrets and variables listed in that workflow, then run it for the intended version. It repeats verification on native runners, prepares signed macOS/Windows artifacts and Linux packages, and uploads per-platform release artifacts. It has no publishing permission and creates no GitHub Release.

## Publishing checklist

- Match the package version and changelog to the release; retain the experimental warning.
- Require passing native CI for every distributed OS and architecture. Validate optional Office conversion on each supported platform and check Windows terminal Ctrl+C manually.
- Confirm valid Windows signatures and macOS notarisation; do not publish development installers as signed releases.
- Review LICENSE, NOTICE, dependency inventories and Electron/Chromium notices in the final packages. Builds include these files and the changelog.
- Check the source archive and release checksums. Distribute selected artifacts rather than the working directory, which can contain local settings, caches and user outputs.
- Verify that GitHub private vulnerability reporting is enabled and the reporting route in SECURITY.md works.
- Publish the verified artifacts and their checksum manifests together. No automatic updater is configured; users install updates manually.
