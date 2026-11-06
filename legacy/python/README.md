# Email-to-PDF CLI

`msg2pdf` bulk-converts Outlook `.msg` and standard `.eml` email files into clean, archival-style PDFs without requiring Outlook or Microsoft Office.

Use `--all-to-pdf` for a mixed export folder: emails and Microsoft Office files are converted to PDFs, and existing PDFs are copied to the output folder.

## Installation

Python 3.12 or newer is required. Use a fresh virtual environment, then install the package with:

```bash
python -m pip install .
```

WeasyPrint also needs its platform rendering libraries. On macOS, install Pango if it is not already available:

```bash
brew install pango
```

Office conversion requires an official LibreOffice **26.2.6+ on the 26.2 branch, or 26.8.1+**, including current security updates. On macOS:

```bash
brew install --cask libreoffice
```

The converter checks `soffice`/`libreoffice` on `PATH`, the current Python environment, and standard LibreOffice application locations. For another installation, set `MSG2PDF_SOFFICE` to the executable's full path. Email conversion and PDF copying work without LibreOffice. Office files are converted using LibreOffice's [document conversion command](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) with a separate temporary profile for each file.

On Ubuntu/Debian, install the rendering libraries and Office sandbox:

```bash
sudo apt-get install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core bubblewrap
```

Install a supported LibreOffice release from [the official download page](https://www.libreoffice.org/download/download-libreoffice/); older distribution packages are rejected. Linux Office conversion needs working unprivileged user namespaces for bubblewrap. Systems that disable them fail with an error rather than converting without isolation.

On Windows, email conversion and PDF copying run natively. Install [MSYS2](https://www.msys2.org/), then run `pacman -S mingw-w64-ucrt-x86_64-pango` in its UCRT64 shell. In PowerShell:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
$env:WEASYPRINT_DLL_DIRECTORIES = "C:\msys64\ucrt64\bin"
python -m pip install .
```

Native Windows Office conversion is deliberately disabled because this application cannot enforce a filesystem/network sandbox there. Use WSL2 and the Linux installation steps for Office documents. macOS uses `sandbox-exec`; sandbox failure is reported as a conversion failure. See [WeasyPrint's platform installation and troubleshooting instructions](https://doc.courtbouillon.org/weasyprint/latest/first_steps.html#installation) if native libraries cannot be found.

Install fonts needed by your mail and documents on every machine. Font fallback and LibreOffice layout can change pagination; the generated PDFs are not guaranteed to be visually identical across systems.

For reproducible development and tests, install [uv](https://docs.astral.sh/uv/) and use the committed lockfile:

```bash
uv sync --locked --extra test --group dev
uv run --locked pytest
uv run --locked ruff check .
uv run --locked python -m build
uv run --locked pip-audit --skip-editable
```

CI is configured to test Python 3.12 and 3.14 on macOS, Linux and Windows, including tests against an installed wheel. Optional real Office integration tests run with `MSG2PDF_TEST_OFFICE=1` and a supported LibreOffice installation; they never substitute for the unit tests.

## Usage

```bash
msg2pdf --input ./emails --output ./pdf --recursive
```

The input can be one `.msg` or `.eml` file, or a directory containing either format. Directory input searches only the immediate directory by default; add `--recursive` to search nested folders and reproduce their relative structure under the output directory. Extensions are matched without regard to case.

For a single EML file:

```bash
msg2pdf --input ./email.eml --output ./pdf --extract-attachments
```

EML support decodes email headers, MIME transfer encodings, and declared body charsets, prefers HTML when available, and falls back to plain text. MIME attachments use the same filename, extraction, Office conversion, and inline-image rules as MSG attachments. Attached emails remain separate `.eml` files; their bodies and attachments are not merged into the parent email. No additional dependency or flag is needed for EML input.

Useful options:

```text
--all-to-pdf           Convert Office files too, and copy existing PDFs
--extract-attachments  Save file attachments, excluding inline and hidden resources
--overwrite            Replace existing PDFs and extracted attachments
--verbose              Print each converted or skipped file
```

## Mixed export folders

```bash
msg2pdf --input ./export --output ./pdf --recursive --all-to-pdf --extract-attachments --verbose
```

With `--all-to-pdf`, the input can be a mixed directory or a single supported file. It processes:

- Outlook `.msg` and standard `.eml` emails using the usual email renderer.
- Word `.doc`, `.docx`, `.docm`, `.dot`, `.dotx`, `.dotm`, and `.rtf` files.
- Excel `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.xlt`, `.xltx`, and `.xltm` files.
- PowerPoint `.ppt`, `.pptx`, `.pptm`, `.pps`, `.ppsx`, `.ppsm`, `.pot`, `.potx`, and `.potm` files.
- Existing `.pdf` files, copied unchanged; names are made portable when needed.

Extensions are matched without regard to case. Use `--recursive` to preserve the input's subfolders under the output directory. All modes require a separate output directory. It cannot be the input directory or an ancestor containing the input; a nested output directory is automatically excluded from discovery. Input files remain unchanged. Other file types and Office lock files beginning with `~$` are left out and counted as unsupported; `--verbose` lists them. The summary separates converted files, copied PDFs, existing outputs skipped, unsupported files, and failures. A failure on one file does not stop the rest of the folder.

Ordinarily, `report.docx` becomes `report.pdf`. When several inputs would have the same PDF name, the source extension is retained: `report.docx`, `report.xlsx`, and `report.pdf` produce `report.docx.pdf`, `report.xlsx.pdf`, and `report.pdf`. Numbered suffixes resolve any remaining collisions. Names are portable to Windows, macOS and Linux and are stable on repeat runs with the same input set. Input subfolder names are also sanitised; colliding folder names receive suffixes. Existing destination files are skipped unless `--overwrite` is supplied.

Combine `--all-to-pdf` with `--extract-attachments` to also convert extracted Office attachments to PDF. Existing PDF attachments are saved unchanged, while inline and hidden resources remain excluded. Other extracted attachment types retain their original formats, including ordinary photos and attached `.msg`/`.eml` emails. The summary counts source files; extracted attachments are processed as part of their parent email.

Office rendering follows LibreOffice's layout, print areas, and available fonts. Password-protected, damaged, or unsupported documents are reported as failures. Each Office conversion has a two-minute timeout; failed conversions leave any previous output PDF intact.

## Email attachments

To extract attachments too:

```bash
msg2pdf --input ./emails --output ./pdf --recursive --extract-attachments
```

Attachments are saved alongside their email's PDF, prefixed with the email's filename. For example, `Email 1.msg` containing `contract.pdf` produces `Email 1.pdf` and `Email 1 - contract.pdf` in the same output folder. Repeated attachment names receive numbered suffixes, such as `Email 1 - contract (2).pdf`. Unsafe filename characters and path components are removed or replaced; long names are shortened to fit filesystem limits. No attachment subfolders are created. Attachment names are reserved across every email in the same output folder, so different emails cannot overwrite each other's attachments.

Extraction saves ordinary file attachments and attached emails (saved as `.msg` or `.eml` files). Inline resources referenced by the email body, hidden attachments, and MIME attachments marked inline are excluded, so signature logos and images displayed in the PDF are not also saved as separate files. Ordinary attached photos are still extracted. Attachments remain in their original formats. Existing attachment files are skipped unless `--overwrite` is supplied. You can add `--extract-attachments` to a previous run to extract attachments even when the PDFs already exist; the summary's converted/skipped counts refer to PDFs. Missing or unsupported attachment data is reported as a conversion failure, and the batch continues. Files already extracted before a failure remain available.

Previously extracted inline images are not deleted on a rerun. Use a fresh output folder if an earlier run already extracted signature images.

With recursive input, a separate output directory nested inside the input is excluded from discovery so extracted `.msg` and `.eml` files are not processed as new emails.

The equivalent module invocation is:

```bash
python -m msg2pdf --input ./emails --output ./pdf --recursive
```

## Supported behaviour

- Preserves From, To, optional Cc, sent date/time, and subject metadata.
- Renders an HTML body when available and falls back to plain text.
- Preserves basic HTML formatting, tables, lists, emphasis, and embedded inline images where the email contains the image data.
- Lists attachment filenames without embedding normal attachments.
- Optionally saves attachments beside the PDF using `--extract-attachments`.
- Processes one file at a time and continues after individual conversion failures.
- Uses A4 pages, readable sans-serif typography, wrapping for long addresses and URLs, and a compact metadata header.

Exit codes are `0` for successful conversion or skipping, `1` when one or more files fail, and `2` for invalid CLI arguments or unusable paths.

## Known limitations

- Without `--all-to-pdf`, only `.msg` and `.eml` files are processed. PST remains out of scope.
- Normal attachments are listed but not converted or embedded in the PDF; extracting them is optional.
- Remote images, stylesheets, and other external resources are not downloaded. Email HTML is sanitised and CSS is scoped to the message body; scripts, document-wide page rules, positioning, and other unsafe formatting are removed. Embedded CID images are supported when their data is available in the email.
- There is no GUI, OCR, threading, configuration file, or parallel processing.

## Conversion limits and output safety

Email PDFs are rendered in separate workers with a 60-second elapsed-time limit and a 1.5 GiB memory budget. Linux adds a hard address-space limit, Windows uses a Job Object, and macOS uses a process-tree resident-memory watchdog sampled every 50 ms (brief overshoot is possible). Office workers have a 120-second limit, the same memory budget, and no network access. Office inputs are copied into a private workspace, and the sandbox allows output writes only there; macros are disabled in the temporary profile. Office external links cannot load private user files outside that workspace.

Individual input files are limited to 100 MiB, email bodies to 10 MiB, and decoded attachments to 64 MiB each / 128 MiB total. Generated PDFs and worker diagnostics have a 256 MiB limit. Parsing still occurs in the main process and is bounded by input/decoded size checks; the rendering worker is not a general malware-analysis sandbox.

Use an output directory you exclusively control during a run. Existing symlinks and Windows junctions beneath the chosen output root are rejected; the application does not defend against a separate hostile process changing the directory tree concurrently. Unreadable folders are reported as failures. Atomic writes preserve previous outputs when conversion fails. A parent email can leave successfully extracted attachments behind if a later attachment or PDF fails.

## Sharing and licensing

**Project licensing is pending the owner's review. No project licence has been granted by this repository.** The direct dependency `extract-msg` is GPL-3.0; review its terms and those of other dependencies before distributing or publishing this application. Dependency notices are recorded in `THIRD_PARTY_NOTICES.txt`; native libraries and LibreOffice have their own licences and are installed separately.

Create a clean source archive for review with:

```bash
python scripts/source_archive.py
```

The archive uses an explicit allowlist and excludes virtual environments, generated package/build metadata, local mail, PDFs, caches and operating-system metadata. Keep the development virtual environment locally; do not copy it between machines. Build wheels with `python -m build` and test them in a fresh environment before distribution. A review archive does not resolve the pending licence decision.
