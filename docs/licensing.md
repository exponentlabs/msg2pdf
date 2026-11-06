# Licensing

Original msg2pdf code and documentation are licensed under the [Apache License, Version 2.0](../LICENSE), copyright 2026 Exponent Labs. [NOTICE](../NOTICE) records the project attribution. Third-party components and assets retain their own terms. `package.json` declares `Apache-2.0`; `private: true` prevents accidental npm publication without restricting licensed distribution.

## Dependencies

Production dependencies use Apache-2.0, MIT/MIT-0, BSD, ISC or OFL-1.1 terms. The MSG parser, `@kenjiuno/msgreader`, is Apache-2.0. `@zone-eu/mailsplit` offers `(MIT OR EUPL-1.1+)`; this distribution relies on its MIT option. Electron uses MIT terms alongside Chromium and other third-party notices. Bundled Poppins fonts use the SIL Open Font License. The development-only synthetic MSG writer, `cfb`, is Apache-2.0.

Run `pnpm licenses:generate` to collect locked production versions, the bundled font snapshot and full upstream licence/notice files. Builds regenerate `resources/THIRD_PARTY_NOTICES.txt` and `resources/third-party-notices.json` automatically. Keep the Electron/Chromium notices supplied by the packager. Font attribution and file hashes are retained in `resources/fonts/`.

LibreOffice is installed separately through its official website or selected from an existing installation. Its own terms apply. Review its redistribution obligations before bundling it in a future release.

## Redistribution

Source archives and application packages include LICENSE and NOTICE alongside third-party notices. Include these files when redistributing, preserve applicable attribution and copyright notices, and mark modified files as required by Apache-2.0. Review generated notices and final artifact contents before release.

The software is provided without warranty, subject to the terms and limitations in LICENSE.
