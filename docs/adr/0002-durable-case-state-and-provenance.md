# ADR 0002: Durable case state, revision provenance and recovery

- Status: Accepted for the initial Fedora profile
- Date: 9 November 2026
- Scope: Persistence and filesystem transactions

## Context

`AppStore` retains 20 recent batch summaries and at most 500 results per summary. That is useful activity history, but cannot serve as the full record of a redaction case. Approvals must refer to exact bytes and decisions, and filesystem writes cannot be committed atomically with database transactions.

## Decision

Use a versioned SQLite database per case for complete structured state. Keep document bytes outside the database in managed paths. Select and test the SQLite binding against the packaged Electron runtime before adding a dependency; the host Node version is not evidence of packaged compatibility. Keep `AppStore` for preferences and recent-case pointers.

Model these records explicitly:

| Record              | Identity and evidence                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| Case                | ID, schema version, creation time, policy version                             |
| Document/source     | ID, source hash/size, private original name/origin, intake ID                 |
| Family edge         | Parent, child, attachment disposition, extraction outcome                     |
| Review revision     | Source/parent hash, PDF hash, page boxes/rotations, converter version/options |
| Redaction plan      | Revision hash, plan revision, page regions, reasons, reviewer decisions       |
| Candidate           | PDF hash, plan hash, engine/settings version, sanitizer profile               |
| Verification/review | Candidate hash, check results, reviewer identity label, time, scope           |
| Release             | Frozen member/disposition manifest, approval, published path, artifact hashes |
| Operation/event     | Operation ID, expected state version, intent, outcome, recovery evidence      |

Use SHA-256 hashes of captured artifact bytes and a deterministic serialization for plan/policy hashes. Hashes establish content identity and detect changes; they do not prove who operated the app or protect against an attacker rewriting both files and database. Actor labels in a local single-user app are attribution, not authenticated signatures.

Store append-only application events with each state transition in the same database transaction. Events reference IDs and reason codes; avoid duplicating source text, search phrases or original filenames. This is a local audit history, not an independently tamper-proof ledger.

Use one writer per working folder, optimistic state-version checks and bounded worker jobs. GUI and CLI obtain the same case lock and invoke the same transition service. Reject concurrent modification rather than silently replacing a newer plan.

## Lock ownership and recovery entry

Use an OS-held exclusive lock on a persistent case-local lock file. The case service owns the handle for the entire open session, including reconciliation; child workers must not inherit it. Select and verify the platform adapter in S03 before implementing the store. The existing converter's create-exclusive `.msg2pdf.lock` file is not the studio lock protocol.

The Fedora adapter additionally holds an exclusive lock on the case root directory for the whole session. Acquire this guard before opening lock metadata; it prevents accidental unlink/recreation of the metadata file from admitting a second live owner. Validate the held directory/file identities before writes. Both descriptors are close-on-exec and close with the session. This supplements the persistent-file protocol; it does not authorize deleting locks or claim resistance to a malicious local user.

Keep the lock file at a stable path and never unlink or replace it to recover ownership. Owner metadata (process/session ID and start time) is diagnostic only: file existence, elapsed time, a PID lookup or a heartbeat must never authorize stealing a lock. If exclusive acquisition fails, return `CASE_BUSY`; if locking is unsupported or its outcome is uncertain, return `CASE_LOCK_UNAVAILABLE` and deny case mutations.

After owner termination, the next opener must successfully acquire the OS lock before inspecting unfinished operations. Only that owner reconciles state, and all mutation/publication commands remain disabled until reconciliation succeeds. Unexpected artifacts produce integrity blockers. Two simultaneous reopen attempts must result in exactly one recovery owner. Verify handle release after forced termination and lock contention in the packaged runtime on every supported OS.

## Durability boundary

The first publication slice guarantees recovery from application/worker termination while the guest OS and filesystem remain running. An acknowledged state transition must survive application restart; an interrupted operation must reconcile to recorded approved bytes or remain blocked. This is not a guarantee of loss-free recovery from a VM reset, OS crash, power failure or storage failure.

Use explicit SQLite transactions with a verified durability configuration; the initial store profile is rollback journal (`journal_mode=DELETE`) and `synchronous=FULL`. Verify effective settings when opening the case and fail closed if the selected packaged binding cannot enforce them. Persist artifact data before committing state that references it. Sync containing directories for new entries and promotion where the platform adapter supports it, recording unsupported behavior in native evidence rather than silently claiming equivalent durability. WAL is a separate profile requiring backup/recovery evidence before adoption.

After any restart, including an unclean guest restart, reconcile pending operations and check published manifests/artifact hashes before enabling app-mediated sharing. Missing or mismatched committed artifacts are integrity failures, not successful recovery; preserve evidence and require recovery from a consistent backup. An automatic restart must never reconstruct approval from filesystem contents. Extending the guarantee to VM reset/power loss requires a follow-up decision, platform-specific flush ordering and destructive reset tests on supported storage; process-kill tests do not establish it.

## Commit and recovery protocol

1. Persist an operation intent with expected input hashes and state version.
2. Produce private artifacts in case-local staging; close, sync and validate their bytes. Recheck gate evidence before finalizing.
3. For a release, include the final allowlisted manifest and all output hashes in the staged package. Record the prepared outcome durably.
4. Promote the complete directory on the same filesystem to a fresh, non-existing release ID under the case lock. Never overwrite an existing release. Validate destination ancestry and filesystem capabilities.
5. Commit the published state/event. On restart reconcile unfinished operations before enabling release actions.

Under the process-termination boundary above, a crash before promotion leaves no package in the final stage. After promotion but before the final database commit, recovery compares the prepared intent, recorded approvals, manifest and every artifact hash before completing the record. Unexpected directories, missing files or mismatches become integrity blockers; they are not accepted as successful releases. This closes application recovery gaps without claiming a database/filesystem distributed transaction.

Back up a case through a consistent snapshot that includes its database and all referenced artifacts; do not copy a live database file in isolation. Version migrations transactionally, preserve a recoverable pre-migration backup and reject newer unsupported schemas. Initial support is for trusted local filesystems; network shares, concurrent sync and multi-user editing are outside the first release's guarantees.

## Alternatives and consequences

- Extending bounded activity JSON loses full provenance. A full JSON manifest plus journal is viable but requires rebuilding indexing and transactional updates.
- SQLite adds runtime packaging and migration work; it supplies a clear transaction boundary for state and events.
- Case-local staging enables same-volume promotion but requires disk-space accounting and recovery cleanup.

## Acceptance evidence

- Kill the process at each commit boundary, reopen and observe either the previous state or a fully reconciled operation.
- Kill the lock owner, then race two reopeners; exactly one acquires ownership and reconciles. A live owner cannot be displaced by deleting metadata or waiting for a timeout.
- Verify effective SQLite settings and artifact-before-state ordering; missing committed artifacts after an unclean guest restart block sharing without synthesizing approvals.
- Stale plan writes and stale approvals are rejected with actionable blockers.
- External changes, duplicate inputs, case relocation, unsupported schemas and competing app instances have defined outcomes.
- Backup/restore preserves document relationships and evidence; missing artifacts block dependent transitions.

## Initial implementation evidence

The bounded Fedora ARM64 implementation and local checks are documented in the [studio guide](../studio.md). Other studio platforms remain unqualified. The raster profile uses whole-line text selection, explicit inline-resource exclusions, a single local reviewer and process-termination recovery; it does not claim native-file component review, authenticated approval or VM-reset/power-loss durability.
