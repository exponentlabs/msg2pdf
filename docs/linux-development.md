# Linux development and machine handoff

Target for this handoff: **Fedora ARM64 in a VM on an Apple Silicon Mac, with a desktop session**. Instructions were reviewed on 9 November 2026. They have not yet been executed in that VM. Existing Linux CI runs on Ubuntu 24.04 x64; it is useful baseline evidence, not Fedora/ARM64 validation.

## What to take to the VM

Take the repository's source, resources, lockfile, configuration and documentation. Reinstall dependencies inside Fedora. Do not reuse macOS `node_modules`, `out`, `release` binaries, pnpm stores or Electron downloads: Darwin ARM64 and Linux ARM64 are different targets.

Use a checkout inside the guest's home directory on its native Linux filesystem. Use a Mac shared folder to transfer an archive, then copy/extract it into the guest. This avoids making development depend on shared-folder locking, permissions, symlinks and hard-link behavior. Output writes require a filesystem with hard-link support.

The redaction ADRs, implementation plan and this guide are maintained in the repository. Use the pushed handoff commit when cloning or updating in Fedora. For subsequent work, local uncommitted changes only transfer through a source snapshot or after they are committed and pushed.

Choose either transfer route:

1. **Git, preferred for continuing development:** clone the repository in Fedora, or pull the pushed branch into an existing clean checkout. Record `git rev-parse HEAD` and check that `docs/adr/README.md`, `docs/redaction-studio-plan.md` and this guide exist before starting. For subsequent handoffs, review and commit the required source/documentation and push it through your normal workflow first.
2. **Current source snapshot:** run `pnpm source:archive` on the Mac and transfer `release/msg2pdf-source.tar.gz`. The allowlisted archive includes current files, including uncommitted/new documents under `docs`, and excludes `.git`, dependencies, build output and root `.env` files. It has no Git history. It is a snapshot, not a Git patch and not a general backup of arbitrary untracked files outside the allowlist.

To preserve history when using a snapshot, record the source checkout's commit ID alongside it, clone the repository in Fedora, create a local branch from that commit and extract the archive over that checkout. Review the resulting diff. For this planning handoff the base commit is `178f386c3bc0f3709d0f570922e397687e53dd57`; record a new one for later snapshots.

Generate a companion checksum on the Mac from the `release` directory:

```sh
shasum -a 256 msg2pdf-source.tar.gz > msg2pdf-source.tar.gz.sha256
```

In Fedora, from the directory containing both transferred files:

```sh
sha256sum -c msg2pdf-source.tar.gz.sha256
tar -tzf msg2pdf-source.tar.gz
```

For a standalone buildable snapshot, extract into a new empty guest-local directory:

```sh
mkdir -p ~/Development/msg2pdf
tar -xzf msg2pdf-source.tar.gz -C ~/Development/msg2pdf --no-same-owner
cd ~/Development/msg2pdf
```

Use an empty directory for this route. A Git checkout with deliberately overlaid snapshot changes is the separate history-preserving route described above.

## Fedora system packages

Run these in the Fedora desktop terminal as your normal user. `sudo` is for installing OS packages, not running Electron or project commands.

```sh
sudo dnf install git tar gzip curl file which \
  gtk3 nss alsa-lib libXScrnSaver libXtst mesa-libgbm \
  bubblewrap xorg-x11-server-Xvfb xorg-x11-xauth
```

Most desktop libraries may already be installed. Xvfb gives the integration suite an isolated X11 display even when the interactive desktop uses Wayland. Fedora documents `xvfb-run` for graphical tests in its [graphical testing guide](https://www.fedoraproject.org/wiki/PackageMaintainers/GraphicalTests). See the [Fedora GTK](https://packages.fedoraproject.org/pkgs/gtk3/gtk3/) and [bubblewrap](https://packages.fedoraproject.org/pkgs/bubblewrap/bubblewrap/) package records for the runtime/sandbox packages.

## Node and pnpm

Use **Node 24**, matching `.node-version`, and **pnpm 12.16.1**, matching `package.json`. Choose a current security patch within the Node 24 line. The default version offered by a new Fedora release or the Node download page may be a different major.

Fedora provides versioned [Node 24 packages](https://packages.fedoraproject.org/pkgs/nodejs24/):

```sh
sudo dnf install nodejs24 nodejs24-npm
```

On Fedora releases that split command symlinks into separate packages, also install `nodejs24-bin` and `nodejs24-npm-bin` to expose `node` and `npm`. If another Node major already owns those commands, use a user-managed Node 24 installation rather than blindly removing unrelated packages. The [official Node downloads](https://nodejs.org/en/download) offer Linux ARM64 builds; verify the downloaded distribution using their published checksums/signatures.

Confirm the runtime before installing project dependencies:

```sh
node --version
node -p 'process.platform + "/" + process.arch'
npm --version
```

Expect `v24.x` and `linux/arm64`. `uname -m` should report `aarch64`. A macOS executable or an emulated x64 Node installation is not the intended setup.

Install the pinned pnpm into a user-owned prefix, if it is not already available:

```sh
npm install --global --prefix "$HOME/.local" pnpm@12.16.1
export PATH="$HOME/.local/bin:$PATH"
pnpm --version
```

Persist that PATH entry in your shell's startup file if needed. See [pnpm installation](https://pnpm.io/installation). Do not introduce an npm/yarn lockfile. `pnpm-workspace.yaml` contains the dependency age, peer and build-script policies; keep those policies in effect.

## Install and start development

From the guest-local repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec install-electron --no
node -p 'require("electron")'
pnpm dev
```

The second command fetches the pinned Electron runtime before timed integration tests, matching CI. Downloads need network access; running the built converter does not require uploads or an account. The printed Electron path should point into this Fedora installation's dependencies.

`pnpm dev` starts Vite on `127.0.0.1:5173` and opens Electron in the VM desktop. The port must be free. Do not expose the development server beyond the guest loopback interface. The script watches/rebuilds main/preload bundles, but restart it after changes to those processes so they load the new code. Renderer edits use Vite's development updates.

Run the app in the guest's desktop session first. No Playwright browser download is required by the current test suite: it launches the project's Electron runtime.

## Verify the Fedora ARM64 environment

Run the same checks as the project, with Xvfb around the Electron tests:

```sh
xvfb-run -a pnpm check
pnpm audit:production
pnpm package:dir
xvfb-run -a pnpm test:packaged
```

`pnpm check` includes type checking, lint, unit tests, production build and real Electron tests. The macOS-only sandbox unit tests skip on Linux. The real Office integration test skips until explicitly configured below. Skips are not evidence for the skipped capability.

On native ARM64, the current packaged test looks for `release/linux-arm64-unpacked`. The unpacked app and its bundled CLI are the development validation targets. Current installer configuration produces AppImage/DEB, not RPM. Do not install a DEB on Fedora or treat an Ubuntu x64 installer as the ARM64 development runtime. Adding Fedora RPM distribution is separate packaging work.

Record the Fedora release, VM software/version, `uname -m`, Node/pnpm/Electron versions, desktop session type, command results and skipped tests in [verification](verification.md). Successful macOS checks do not establish VM compatibility. The initial smoke test should open the UI, preview/convert synthetic mail and reopen a produced PDF.

## Optional Office conversion

Email conversion and PDF copying do not need LibreOffice. To test Office conversion, install Fedora's components:

```sh
sudo dnf install libreoffice-writer libreoffice-calc libreoffice-impress
libreoffice --version
command -v libreoffice
```

Use the application's supported stable version range in [usage](usage.md); do not lower its version check to accept an older distro package. The app searches `/usr/bin/libreoffice` and `/usr/bin/soffice`. A separately installed executable can be selected in Settings or supplied through `MSG2PDF_SOFFICE`/`--office`.

Enable the real sandboxed Office integration test explicitly:

```sh
MSG2PDF_TEST_OFFICE=/usr/bin/libreoffice xvfb-run -a pnpm test:e2e
```

Substitute the actual supported executable if it is elsewhere. `MSG2PDF_TEST_OFFICE` enables the test; `MSG2PDF_SOFFICE` configures normal conversion. Fonts and LibreOffice import filters affect output layout, so validate representative synthetic documents in this guest.

## Linux sandbox and VM troubleshooting

Keep `app.enableSandbox()`, Chromium renderer sandboxing and bubblewrap enabled. Run as a normal user. Do not solve failures with `--no-sandbox`, `sudo pnpm dev`, SELinux permissive mode or a global user-namespace security downgrade.

Fedora normally supports unprivileged user namespaces, which bubblewrap uses. See the [upstream namespace requirements](https://github.com/flatpak/flatpak/wiki/User-namespace-requirements). A VM alone does not prove the required isolation works; verify it inside the guest. Ubuntu/AppArmor instructions are not Fedora/SELinux configuration instructions.

| Symptom                                   | Check and next step                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Exec format error` or wrong architecture | Confirm `linux/arm64`, inspect the downloaded executable with `file`, and reinstall dependencies inside Fedora rather than copying macOS files                                                                 |
| Missing shared library                    | Run `ldd` on the trusted installed Electron binary; use `dnf provides '*/<missing-library>'` to identify the Fedora runtime package                                                                            |
| Missing display/Wayland connection        | Launch from the desktop terminal; use `xvfb-run -a` for tests. Record `XDG_SESSION_TYPE`, `DISPLAY` and `WAYLAND_DISPLAY` when diagnosing                                                                      |
| Chromium sandbox or namespace failure     | Inspect the actual error, installed kernel/policy and any stale `CHROME_DEVEL_SANDBOX` inherited from another setup. A Fedora development host should not copy the Ubuntu CI runner's privileged setup blindly |
| `bwrap` permission/namespace failure      | Check `/usr/bin/bwrap`, `unshare -Ur true`, and SELinux audit denials. These diagnose prerequisites; only the real sandboxed Office test validates the application path                                        |
| SELinux denial                            | Capture `getenforce` and relevant audit events with `sudo ausearch -m AVC,USER_AVC -ts recent` when audit tools are installed; resolve the specific distro/package policy issue                                |
| Blank window or GPU-process crash in VM   | Record the guest compositor and virtual GPU/3D configuration; test the synthetic UI on Xvfb to narrow the display issue. Do not change sandbox policy as a graphics workaround                                 |
| Packaging fails but development works     | First validate `package:dir` and `test:packaged`; installer tools/architectures and Fedora RPM support are separate concerns                                                                                   |

The workflow's root-owned setuid sandbox helper configuration is explicitly for ephemeral Ubuntu CI runners. It is not a prerequisite to apply automatically to this Fedora VM. If Fedora's namespace policy blocks development, document the concrete denial and resolve it using supported host policy before claiming sandbox verification.

## Data, settings and secrets

No service credentials, `.env` file, Outlook installation, external database or cloud account is required for normal development/tests. Repository access credentials, if needed for Git, are separate. Signing/notarisation credentials are only for platform release preparation; they are not needed to develop in Fedora.

Current app preferences/history are outside the repository. Reconfigure the LibreOffice path and output locations in Fedora; macOS paths are not portable. Keep private mail, real conversion outputs and signing material outside the checkout and source archive. The source archive is for development files, not user data.

The proposed managed redaction cases and SQLite case store are not implemented yet, so there is no live studio database or case migration to perform at this handoff. When cases exist, use a consistent case backup/restore with its artifacts as specified in [ADR 0002](adr/0002-durable-case-state-and-provenance.md).

## Continue the redaction work

Read [CONTRIBUTING](../CONTRIBUTING.md), [architecture](architecture.md), the [ADR index](adr/README.md) and the [implementation plan](redaction-studio-plan.md). These are the durable handoff; the previous chat is not required to understand the work.

Current state: the converter is implemented; the studio has eight ADRs and eleven work packages. The three-stage product direction and Fedora ARM64 storage/lock approach are accepted within their recorded scopes. The [B1 compatibility experiment](b1-fedora-arm64.md) proves packaged adapters locally and records remaining profile-qualification gaps. Built-in SQLite is selected for local case-store development; no studio database, production viewer editor or release-enabled redaction engine/profile is implemented.

Start with S01–S03 and work toward M1: one PDF captured in a case, marked, saved/reopened, sanitized, reviewed and published through the shared gates. Include Linux ARM64 in the engine and SQLite-binding spikes, not just macOS ARM64 or Linux x64. Do not change distribution licensing or add a paid dependency without resolving that choice explicitly.

Keep the existing converter tests passing and add the plan's domain, integrity and redaction evidence as implementation arrives. See [verification](verification.md) and [distribution](distribution.md) for the existing build/release boundaries.
