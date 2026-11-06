# Usage and requirements

## Office conversion

MSG and EML conversion and PDF copying are self-contained. Office conversion requires a separate LibreOffice installation: 26.2.6 or later in the 26.2 branch, or 26.8.1 or later. Settings can detect or locate an installation and open the official installer download page. Downloading and installation remain user actions.

Windows installations should be all-users installations in Program Files so AppContainer processes can read them. Linux Office conversion requires `bubblewrap` and enabled unprivileged user namespaces. Unsupported isolation configurations fail with guidance.

`--office /path/to/soffice` overrides the saved GUI setting. `MSG2PDF_SOFFICE` is also supported. CLI defaults include email files only, without recursion or attachment extraction. GUI defaults include subfolders and Office/PDF files. CLI execution never prompts.

Linux PDF generation requires a graphical session, or `xvfb-run` on a server. Keep Electron's sandbox enabled; `--no-sandbox` and running as root are unsupported.

## Supported files

- Email: `.msg`, `.eml`.
- Word and RTF: `.doc`, `.docx`, `.docm`, `.dot`, `.dotx`, `.dotm`, `.rtf`.
- Excel: `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.xlt`, `.xltx`, `.xltm`.
- PowerPoint: `.ppt`, `.pptx`, `.pptm`, `.pps`, `.ppsx`, `.ppsm`, `.pot`, `.potx`, `.potm`.
- Existing `.pdf` files are copied unchanged.

Original inputs remain untouched. Referenced files and remote URLs inside messages are never fetched. Active content, remote images, global email styles, SVG and external fonts are removed; raster inline CID images are embedded. Complex layouts may differ from Outlook.

Password-protected/encrypted or opaque S/MIME mail must first be exported/decrypted by a mail client. Signed MIME content is rendered without cryptographic signature verification. Unreadable messages fail explicitly.

## Results and cancellation

Existing files are skipped unless overwrite is enabled. Output names are allocated deterministically for portable filesystems. A batch continues after individual file failures. If an attachment fails, the primary email PDF and other readable attachments are retained. The file is marked `partial`; converted and failed counts can overlap. The failure count and terminal exit code signal that attention is needed.

Ctrl+C stops terminal work and retains completed outputs. A report that already exists is skipped unless `--overwrite` is supplied.

Output commits are atomic. The no-overwrite commit requires filesystem hard-link support, such as APFS, NTFS or ext4. Unsupported filesystems report failures; use a supported local destination before copying to removable/network storage. Use a trusted output folder.

An output-directory lock prevents competing batches. After a crash, verify that no batch is running before deleting a stale `.msg2pdf.lock` file.

## Resource limits

| Resource                      | Limit                     |
| ----------------------------- | ------------------------- |
| Input file                    | 100 MiB                   |
| Message body                  | 10 MiB                    |
| Metadata field                | 64 KiB                    |
| Individual decoded attachment | 64 MiB                    |
| Total decoded attachments     | 128 MiB                   |
| Attachments per message       | 10,000                    |
| Output PDF                    | 256 MiB                   |
| Discovered files              | 100,000                   |
| Parsing                       | 30 seconds                |
| PDF rendering                 | 60 seconds                |
| Office conversion             | 120 seconds               |
| Parser/render working set     | Monitored against 512 MiB |
| Office process tree           | 1.5 GiB                   |

Jobs run sequentially. Queue pagination bounds renderer work. Working-set monitoring samples periodically; it is not an instantaneous allocation ceiling.

Local activity retains at most 20 batch summaries, with 500 file results per summary. It stores paths and counts, never email bodies. Export a report for a complete batch record. Preferences and history live in the OS application-data directory. Clear activity in the app to remove it.
