# Licensing review remains pending

The owner explicitly requested that the project licence remain undecided. `package.json` therefore declares `UNLICENSED` and `private: true`; there is no new project LICENSE file. These metadata do not make dependencies unlicensed or override their conditions.

The active runtime replaces Python `extract-msg` with the Apache-2.0 `@kenjiuno/msgreader` parser. No GPL implementation is copied into the TypeScript app. Production dependencies have Apache-2.0, MIT/MIT-0, BSD, ISC or OFL-1.1 terms; `@zone-eu/mailsplit` offers `(MIT OR EUPL-1.1+)`, and this distribution relies on its MIT option. Electron has MIT terms plus Chromium and other third-party notices. Font assets use the SIL Open Font License. The development-only synthetic MSG writer (`cfb`) is Apache-2.0.

Run `pnpm run licenses:generate` to collect the actual locked production versions, bundled Poppins font snapshot and full licence/notice files. Review `resources/THIRD_PARTY_NOTICES.txt` and `resources/third-party-notices.json`. Builds regenerate and package them automatically. Keep Electron/Chromium notices shipped by the packager. Retain applicable copyright/permission texts and Apache notices when redistributing. The unmodified Poppins fonts come from the Atlas reference; their SIL Open Font License and file hashes are retained in `resources/fonts/`.

LibreOffice is not redistributed by msg2pdf. A user can install it separately through its official website or select an existing installation. This avoids bundling its application, notices and large platform-specific payload; it does not remove the obligation to use it under its own terms. Revisit that review if bundling LibreOffice later.

The old Python implementation remains under `legacy/python` as an inactive reference. Its original dependency notices are preserved there. Do not treat removal of the Python runtime from the active app as licensing clearance for redistributing that legacy tree. Application packaging and the explicit source-archive command exclude it.

Before public sharing, the owner should select a licence for original code, confirm the right to license all contributions/assets, review generated notices and the final artifact contents, and update package metadata and distribution documentation accordingly. This file records technical dependency provenance and does not choose the licence on the owner's behalf.
