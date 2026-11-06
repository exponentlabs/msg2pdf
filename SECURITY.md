# Security

msg2pdf processes potentially hostile email and Office files locally. The security boundaries are documented in [architecture](docs/architecture.md). Keep Electron, the parsers and optional LibreOffice current. `pnpm audit:production` checks the locked JavaScript runtime dependency graph; it does not cover every Chromium/LibreOffice or native OS issue.

The renderer is sandboxed and cannot use Node. IPC is narrow, schema-validated and restricted to the trusted main frame. Imported paths are granted through native selection/drop operations. Email preview uses a sandboxed iframe; printing uses a separate sandboxed, JavaScript-disabled renderer with network/file requests blocked. Email scripts, external images, SVG and dangerous styles/URLs are removed. Linked attachments and UNC references are not followed.

Worker byte/time/memory budgets limit abusive input. They do not guarantee a zero-overhead memory ceiling: OS working-set checks sample periodically, and a worker can briefly exceed its budget before termination. Office runs behind platform isolation and fails if that isolation is unavailable. The Windows Job Object enforces a hard Office process-tree memory limit. Parsing and rendering are sequential.

Outputs use a private staging directory and atomic commit, with no-overwrite enforced by an exclusive hard link. Symbolic links/junctions inside the output tree are rejected. Directory locks prevent cooperating app instances from overwriting each other's work. Use a trusted local output directory; pathname checks cannot eliminate every race against a malicious process that can concurrently replace ancestor directories. Existing copies/attachments are user data: do not open them automatically or assume that conversion validates their contents. Copied PDFs remain byte-identical and can retain their original active content.

S/MIME signatures are not verified. Encrypted/opaque mail must be exported/decrypted elsewhere. The app does not claim forensic fidelity, signature validation or a malware-free result. Known rendering limits appear in the README.

No telemetry, upload service, account or automatic update check is included. The only app-initiated external navigation is the user's LibreOffice download action. Local history includes file paths/counts; clear it in Recent activity. Email bodies are not stored in activity. Reports deliberately include source/destination paths; review them before sharing.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on the [GitHub repository](https://github.com/exponentlabs/msg2pdf/security) for confidential reports. If private reporting is unavailable, open an issue requesting a confidential contact route without disclosing the vulnerability, customer files or secrets. Do not publish sensitive samples or exploit details in a public issue.

Include the app version, operating system, reproduction steps and a synthetic sample where possible. Contributors can use `tests/fixtures.ts` to construct test data. Only the latest release is maintained; install current releases and keep optional LibreOffice installations updated.
