# msg2pdf

> [!WARNING]
> This tool is experimental and comes with no warranty of any kind.

Convert Outlook messages, email exports and documents to PDFs on your computer. msg2pdf provides a desktop app and a terminal launcher, with no uploads, accounts or telemetry.

- Convert MSG and EML files without Outlook or an external runtime.
- Preview messages, convert batches, preserve subfolders and extract attachments.
- Copy existing PDFs or convert Office documents through an optional LibreOffice installation.
- Export JSON reports and keep a local record of recent conversions.
- Build installers for macOS, Windows and Linux.

## Desktop

Add files or a folder, choose an output folder, then convert. Drag and drop is supported. Existing outputs are skipped unless **Overwrite existing files** is enabled.

| Action       | macOS       | Windows / Linux |
| ------------ | ----------- | --------------- |
| Add files    | Cmd+O       | Ctrl+O          |
| Add a folder | Cmd+Shift+O | Ctrl+Shift+O    |
| Convert      | Cmd+Enter   | Ctrl+Enter      |

For Word, Excel, PowerPoint and RTF conversion, open **Settings → Office conversion** to locate LibreOffice or open its official download page. LibreOffice is installed separately. See [usage and requirements](docs/usage.md) for supported versions, formats and platform requirements.

## Terminal

The terminal launcher is included in each installed app. Add its directory to PATH or invoke it directly:

```sh
# macOS
"/Applications/msg2pdf.app/Contents/Resources/bin/msg2pdf" --help
# Linux unpacked app
./resources/bin/msg2pdf --help
```

On Windows, use `resources\bin\msg2pdf.cmd` inside the installation directory.

```sh
msg2pdf -i ./mail -o ./pdf --recursive
msg2pdf -i first.msg second.eml -o ./pdf --extract-attachments
msg2pdf -i ./export -o ./pdf --recursive --all-to-pdf --json
msg2pdf -i ./mail -o ./pdf --report ./conversion-report.json --page-size Letter
```

`--json` writes a summary to stdout; progress and errors go to stderr. Exit codes are **0** for success, **1** for conversion failures, **2** for invalid arguments/input planning and **130** for cancellation. See [usage](docs/usage.md) for limits, partial results and configuration.

## Build from source

Use Node 24 LTS and **pnpm 12.16.1**. Install pnpm using its [official instructions](https://pnpm.io/installation).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

On Windows, build from an MSVC Developer Command Prompt with the C++ build tools and Windows SDK installed. Linux requires the desktop libraries listed in [distribution](docs/distribution.md).

```sh
pnpm check         # types, lint, unit tests, build and Electron integration tests
pnpm package       # installers for the current OS and architecture
pnpm test:packaged # packaged runtime and PDF conversion checks
pnpm source:archive
```

Build output is written to `release/`. Build each platform on its native OS. Signing, notarisation and release preparation are covered in [distribution](docs/distribution.md). CI artifacts are development builds; public installers must pass the release checks.

## Privacy and limitations

Email scripts, remote images and external resources are removed. Inputs remain unchanged. Complex email layouts may differ from Outlook, and encrypted mail must be decrypted before conversion. S/MIME signatures are not verified. Copied PDFs and extracted attachments retain their original contents.

Local history stores file paths and counts, never message bodies. Clear it in **Recent activity**. Reports contain paths; review them before sharing. See [security](SECURITY.md) and [usage](docs/usage.md) for details.

## Licence

Copyright 2026 Exponent Labs. Original code and documentation are licensed under [Apache-2.0](LICENSE). Third-party components and fonts retain their own licences; distributions include [NOTICE](NOTICE) and [third-party notices](resources/THIRD_PARTY_NOTICES.txt). LibreOffice is not bundled.

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), [design system](docs/design-system.md) and [licensing](docs/licensing.md).
