# ADR 0007: Fedora ARM64 SQLite and case-lock adapter evidence

- Status: Accepted for Fedora ARM64 local development; other platforms unverified
- Date: 9 November 2026
- Scope: S03/B1 storage and ownership adapter selection; refines ADR 0002

## Context

The case store requires SQLite with explicit durability settings and a lock that does not remain owned after process death. Host Node availability is insufficient; both must work inside packaged Electron. The [B1 report](../b1-fedora-arm64.md) supplies executed evidence on this guest.

## Decision

Use the packaged runtime's built-in `node:sqlite` `DatabaseSync` behind a case-store adapter for Fedora ARM64. Electron `45.2.3` exposes SQLite `3.53.4` without a separate SQLite dependency or native-binding rebuild. Verify `journal_mode=DELETE`, `synchronous=FULL` and schema/integrity prerequisites on every case open as required by ADR 0002. Keep synchronous database work outside renderer code; bounded transactions and the service/worker placement belong to B3.

Use an OS-held exclusive nonblocking `flock` on a persistent case-local regular file, through a small Linux Node-API adapter. Keep its descriptor owned by the case service, close it on normal case close, and set close-on-exec. Never delete/recreate the lock file to gain ownership. Map contention and unavailable locking to distinct typed blockers. The spike rejects symlinks and multiply linked lock files; B3 must add canonical case ancestry, permissions and supported-filesystem checks before exposing this to real cases.

Keep storage and lock interfaces portable. This selection authorizes no Windows/macOS support claim, network/synced filesystem guarantee, case-store implementation or power-loss guarantee. Do not substitute SQLite transaction locking for session-long filesystem ownership.

## Alternatives and consequences

- A separate SQLite binding would add native build/packaging work without a demonstrated need on this runtime. Revisit if required database capabilities or supported platforms fail qualification.
- The converter's create-exclusive lock requires manual stale-file removal after a crash; it is not reused for cases.
- A helper-owned lock can outlive a crashed case service. Holding the descriptor in the owner process avoids that lifetime mismatch; workers must not inherit it.
- The Linux addon adds a compiler/header requirement for development and a target-specific binary for packaging. Other OS adapters remain required before supporting those targets.

## Acceptance evidence and remaining work

The packaged probe confirms effective SQLite settings, an integrity check, committed-row survival and interrupted-transaction rollback after SIGKILL. It syncs a synthetic artifact/directory before committing state. The lock tests confirm a live contender is rejected, exactly one of two reopeners gains ownership, inode identity survives recovery, symlink acquisition fails, and a live child does not retain its killed parent's ownership.

Evidence and source/package hashes are in the [recorded report](../evidence/b1-fedora-arm64.json). These adapter checks unblock B3's Fedora storage implementation after B2; they do not replace schema, migration, backup/restore, filesystem-integrity or publication recovery tests.
