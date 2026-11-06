# msg2pdf

A private desktop workbench for turning Outlook messages, email exports and documents into PDFs. Built with TypeScript, Electron and React; managed with pnpm. The desktop app and terminal launcher use the same conversion engine.

The desktop adopts Atlas's **Graphite glass** design: dark translucent surfaces, purple highlights, orange actions and locally bundled Poppins typography. [Design adoption notes](docs/design-system.md) describe the tokens, reference and font provenance.

- MSG and EML conversion needs no Python, Outlook, browser installation, Node installation or online service in the packaged app.
- Preview email safely, convert batches, preserve subfolders, extract ordinary attachments, and export JSON reports.
- Copy existing PDFs unchanged. Optionally convert Word, Excel, PowerPoint and RTF files through a separately installed LibreOffice.
- macOS, Windows and Linux packaging is configured. Build each platform on its own operating system.

## Run from source

Use Node 24 LTS and **pnpm 12.16.1**. Install pnpm from its [official instructions](https://pnpm.io/installation).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

On Windows, use an MSVC Developer Command Prompt with the C++ build tools installed: the optional Office sandbox helper is compiled during builds. Installers include that helper, so end users do not need build tools.

```sh
pnpm check        # strict types, lint/format, unit tests, production build, real Electron tests
pnpm cli --help  # run pnpm build first
pnpm package:dir # portable app for the current OS/architecture
pnpm package     # DMG/ZIP, Windows NSIS installer, or Linux AppImage/DEB
pnpm test:packaged
```

Built applications and installers are written to `release/`. Installers never publish automatically. Signing and notarisation require your own developer credentials; see [distribution](docs/distribution.md).

Pushes to `main` automatically build Windows (x64) and macOS (Apple Silicon and Intel) installers. Download the `installers-*` artifacts from the completed run in [GitHub Actions](https://github.com/exponentlabs/msg2pdf/actions). Artifacts are retained for 14 days; these review builds are unsigned on Windows and ad-hoc signed on macOS.

## Desktop

Add files or a folder, choose a separate output folder, review the queue, then convert. Native drag and drop and keyboard shortcuts are supported: Cmd/Ctrl+O adds files, Cmd/Ctrl+Shift+O adds a folder, and Cmd/Ctrl+Enter starts conversion. Existing files are skipped unless **Overwrite existing files** is enabled. Colliding names are allocated deterministically for portable filesystems.

Settings → **Office conversion** can locate a pre-installed LibreOffice or open the **official installer download** in your browser. After installation, refresh detection or locate its executable. This is an optional, user-driven installation; msg2pdf does not silently download or execute installers. Required stable versions: 26.2.6 or later in the 26.2 branch, or 26.8.1 or later. Windows installations should be in Program Files. Linux Office conversion also requires `bubblewrap` and enabled unprivileged user namespaces. Email conversion does not require LibreOffice.

## Terminal

The terminal launcher ships inside each installed app and uses Electron's bundled Node runtime. Add its directory to PATH, or invoke it directly:

```sh
# macOS
"/Applications/msg2pdf.app/Contents/Resources/bin/msg2pdf" --help
# Linux unpacked app / extracted AppImage
./resources/bin/msg2pdf --help
```

On Windows run `resources\bin\msg2pdf.cmd` inside the installation directory. See [distribution](docs/distribution.md) for paths and AppImage extraction. The GUI executable itself is not the terminal launcher.

```sh
msg2pdf -i ./mail -o ./pdf --recursive
msg2pdf -i first.msg second.eml -o ./pdf --extract-attachments
msg2pdf -i ./export -o ./pdf --recursive --all-to-pdf --json
msg2pdf -i ./mail -o ./pdf --report ./conversion-report.json --page-size Letter
```

`--office /path/to/soffice` overrides the saved GUI setting. `MSG2PDF_SOFFICE` is also supported. CLI defaults include email files only, without recursion or attachment extraction. GUI defaults include subfolders and Office/PDF files. The GUI uses native dialogs; CLI execution never prompts.

`--json` writes one JSON summary to stdout. Progress and errors go to stderr. Exit codes: **0** success, **1** conversion/file failure, **2** invalid arguments or input planning, **130** cancellation. Ctrl+C stops current work and retains completed outputs. A batch continues after individual file failures. A report that already exists is skipped unless `--overwrite` is supplied.

If an attachment fails, the primary email PDF and other readable attachments are retained. The file is marked `partial`, its PDF is included in the converted count, and the failure count/exit code still signal that attention is needed. Converted and failed counts can therefore overlap for a partially completed email.

Linux PDF generation requires a graphical session, or `xvfb-run` on a server. Electron's sandbox remains enabled; do not use `--no-sandbox`. The app does not support running as root.

## Behaviour and limits

- Supported email: `.msg`, `.eml`; Office: `.doc`, `.docx`, `.docm`, `.dot`, `.dotx`, `.dotm`, `.rtf`, `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.xlt`, `.xltx`, `.xltm`, `.ppt`, `.pptx`, `.pptm`, `.pps`, `.ppsx`, `.ppsm`, `.pot`, `.potx`, `.potm`; existing `.pdf` files are copied.
- Original inputs remain untouched. Referenced files/URLs inside messages are never fetched. Remote images, active content, global email styles, SVG and external fonts are removed. Raster inline CID images are embedded. Complex email layouts may differ from Outlook.
- Password-protected/encrypted or opaque S/MIME mail must first be exported/decrypted by a mail client. Signed MIME content is rendered without cryptographic signature verification. Unreadable messages are explicit failures, never silently successful blank PDFs.
- Input file: 100 MiB; message body: 10 MiB; metadata field: 64 KiB; individual decoded attachment: 64 MiB; total decoded attachments: 128 MiB; attachment count: 10,000; output PDF: 256 MiB. Parsing: 30 seconds; PDF rendering: 60 seconds; Office: 120 seconds. Parser/render workers are monitored against 512 MiB; Office against 1.5 GiB.
- Jobs run sequentially, with at most 100,000 discovered files. Queue pagination keeps the renderer bounded. A private output-folder lock prevents competing batches, including CLI/GUI instances. After a crash, verify no batch is running before deleting a stale `.msg2pdf.lock`.
- Output commits are atomic. The no-overwrite commit requires filesystem hard-link support (APFS, NTFS, ext4 and similar); unsupported filesystems report failures rather than risking partial files. Use a local supported destination before copying to removable/network storage. Avoid output folders writable by other users during a batch.
- Local recent activity keeps at most 20 summaries, with 500 file results per summary. It contains filenames/paths and counts, never email bodies. Export a report for a complete batch record. Clear activity in the app to remove it. Preferences/history live in the OS application-data directory.

## Sharing and licensing

**Project licensing is pending owner review.** `UNLICENSED` and `private: true` intentionally prevent accidental package publication. This repository does not currently grant a licence to original project code.

The active application no longer uses `extract-msg` or Python. The inactive original implementation is preserved in `legacy/python/` for reference and excluded from installers and source archives. Do not redistribute that legacy code/dependency environment without a separate licensing review.

`pnpm run licenses:generate` regenerates `resources/THIRD_PARTY_NOTICES.txt` and a machine-readable inventory from locked production dependencies, including full upstream licence texts. Installers include these notices and Electron/Chromium notices. The MSG parser uses Apache-2.0; other runtime dependencies include MIT, BSD, ISC and OFL-1.1 licences. LibreOffice is separately installed and is not bundled. See [licensing](docs/licensing.md) before release.

`pnpm source:archive` creates an explicit allowlisted source archive excluding personal files, caches, Python legacy, dependencies and conversion outputs. Review the result before sharing.

Read [architecture](docs/architecture.md), [security](SECURITY.md), and [contributing](CONTRIBUTING.md) for maintenance details.
