# Fedora redaction studio

The initial studio is implemented for **Fedora 44 ARM64**, Electron 45.2.3, and a local Btrfs/ext4/XFS working folder. Ephemeral tmpfs cases are supported for tests but do not survive reboot. Other studio platforms, network/synced folders, OCR, structural redaction, native-file redaction and multi-user authorization remain outside this profile. The existing converter remains available separately.

## Setup and workflow

Install the system-managed verifier prerequisites once:

```sh
sudo dnf install qpdf poppler-utils bubblewrap util-linux
```

The qualified verifier packages are `qpdf`/`qpdf-libs` 12.3.2-1.fc44.aarch64 and `poppler`/`poppler-utils` 26.01.0-3.fc44.aarch64. Missing or changed versions block processing until requalification. There are no document-time downloads. The packaged app supplies its own Node runtime, PDF.js, assembler and policy checker. Xvfb is a development/test display, not a document-processing prerequisite.

Choose **Redaction studio**, create an empty private working folder, then add PDF, MSG, EML or supported Office documents. Office preparation requires a supported LibreOffice installation (locally tested: 26.2.7.3). Unsupported native attachments remain captured and can be explicitly excluded; archives are not expanded.

Prepare fixed pages before marking. Review the converted appearance, source metadata printed in email headers, and attachment titles as well as the body. Office revisions contain the print view: nonprinted sheets, notes, embedded native objects and other source components may be absent. No approval claims review of every native-file component.

Use rectangle dragging, numeric PDF coordinates, selected text lines or exact-phrase matches to add marks. Text selection/search marks whole line bounds; inspect the visible regions and their neighbors. Every page needs explicit review, including zero-mark pages. Editing marks clears page review and dependent candidate approval. Plans save privately; reopen the case to resume them.

Create an image-only candidate. Independent QPDF object/byte/pixel checks and Poppler parsing/text/attachment/every-page rendering must pass. Review each actual sanitized candidate page in its isolated preview and record the native confirmation. A renderer flag cannot substitute for that confirmation.

Resolve attachment families before release. Every selected family member needs inclusion as a reviewed candidate or deliberate exclusion with a reason. Inline resources are separately accountable: explicitly exclude them when the parent representation is sufficient. Extraction/inventory failures block the affected family. Nested emails retain separate identities; equal bytes are not silently deduplicated across parents.

Tick the desired release subset (or use the currently selected document), approve its native release summary, then publish. The private summary includes original names, exclusions and exact output hashes. The public package contains only neutral `document-001.pdf` names and a minimal manifest. Publication promotes a complete new directory without replacement. Older releases are immutable and shown as superseded when their review context changes. **Open released package** rechecks case/artifact hashes and current evidence before opening the folder. The app cannot revoke copies made outside the case.

## Limits and private data

The raster profile permits at most 8 pages, 4 million aggregate pixels at scale 2, and 100 MiB source/revision artifacts. Intake is bounded to 1,000 document identities, 64 direct attachments per preparation, four nested attachment ancestors, 32 MiB case metadata, and 256 MiB per release operation. Over-budget work fails rather than silently omitting content.

Outputs lose searchable text, OCR, accessibility tags, forms, attachments, source metadata and signatures. They preserve the reviewed snapshot outside outward-rounded black masks. Human review determines which content needs removal; verification establishes that the chosen mask/export profile was applied.

The working folder and backups contain sensitive originals, extracted attachment bytes, text, preview images, plans, verification evidence and private provenance. They are owner-only, unencrypted local data. Keep them off synced/network storage and manage retention deliberately. Office uses an additional owner-private temporary conversion workspace; abnormal process termination can leave temporary Office data under the OS temporary directory. File deletion is not a secure-erasure guarantee.

SQLite rollback journal/FULL synchronization and a persistent-file native flock enforce one case owner. Restart validates schema and hashes, then reconciles only recorded intents. An interrupted prepared publication can complete only its recorded approved package; unknown/tampered files block the case. Backup copies SQLite and registered artifacts consistently; opening an unsupported future schema fails rather than guessing a migration. These checks establish **process-termination recovery**, not loss-free VM reset, power failure or malicious-user resistance.

## Automation

The separate studio command family prints JSON and shares the GUI's store, transition service and gates:

```sh
msg2pdf studio status CASE
msg2pdf studio capture CASE INPUT EXPECTED_VERSION
msg2pdf studio prepare CASE DOCUMENT_ID EXPECTED_VERSION
msg2pdf studio apply CASE DOCUMENT_ID EXPECTED_VERSION
msg2pdf studio publish CASE EXPECTED_VERSION
msg2pdf studio backup CASE EMPTY_PRIVATE_FOLDER
```

Use GUI-created cases and the current version from `status`. There are no CLI review/approval or force commands. `publish` consumes a current GUI-recorded release approval. SIGINT/SIGTERM cancel processing. Legacy converter/report/attachment writes reject managed case destinations.

## Local qualification

Run the full suite and native package checks locally; no Actions run is necessary for iteration:

```sh
MSG2PDF_STUDIO_TEST_ROOT="$PWD/artifacts" MSG2PDF_TEST_OFFICE=/usr/bin/libreoffice \
  xvfb-run -a pnpm check
pnpm audit:production
pnpm package:dir
xvfb-run -a pnpm test:packaged
xvfb-run -a pnpm test:packaged:studio
```

The studio packaged check consumes a real GUI-created approval, publishes through the packaged CLI, compares all public bytes against the manifest, regenerates candidates with the packaged workers, prepares a fresh capture and rejects CLI review bypass. Store tests inject both exceptions and actual SIGKILL at intent/prepared/promoted/committed boundaries, race two reopeners, and exercise tampering, symlinks, backup/relocation and future-schema rejection. The [37-check sanitization evidence](evidence/b1-qualification-fedora-arm64.json) covers fractional edges and the adversarial PDF corpus. The isolated B1 harness remains incapable of granting a case or release approval.

The [final native qualification record](evidence/studio-fedora-arm64.json) captures the tested implementation commit, packaged ASAR/executable/native-adapter hashes, runtime and system package versions, native Btrfs recovery results and exact check counts.
