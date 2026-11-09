# ADR 0005: Attachment families and immutable release packages

- Status: Proposed
- Date: 9 November 2026
- Scope: Release membership, attachment accountability and disclosure outputs

## Context

The converter can retain a primary email PDF while marking attachment failures as `partial`. That behavior is useful for intake, but must not silently produce a complete-looking release. Attachments, names and reports can disclose content independently of the email body.

## Decision

Model an email and its attachments as a document family. Give every attachment an identity and a recorded disposition, including embedded messages, inline images and parser-hidden items such as signature payloads. Retain parent/child provenance privately. Inline material included in the review PDF is reviewed there; this does not authorize exporting its original binary.

Each discovered item must have one of these dispositions before its family can be released:

| Disposition                 | Evidence                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| Include as a reviewed PDF   | Current revision/plan, verified candidate and review decision              |
| Represented on parent pages | Identified parent revision and reviewed page coverage; no raw asset export |
| Exclude deliberately        | Recorded reason and explicit confirmation in the release summary           |
| Blocked/unresolved          | Visible blocker; family is not release-ready                               |

An extraction/inventory failure is unresolved, not an exclusion. Where the parser cannot enumerate a container's children, block release of that family until a complete inventory is obtained or the entire family is deliberately excluded. Bounded nested-message extraction is in scope; archives and unsupported containers block or are explicitly excluded as whole items until support is added. Enforce recursion, aggregate-byte and attachment-count budgets.

Do not merge byte-identical documents' review decisions automatically. Content may be deduplicated internally, while origins, family edges and release inclusion remain separate. Attachment titles and the parent's rendered attachment list are reviewable content too.

A release is a frozen selection of families/documents with an explicit disposition for omitted family members. Case-wide completeness is not required to share a deliberately selected subset. The release summary must make the subset and any exclusions clear before approval.

Create a new immutable-in-app package under `Redacted for sharing/<release-id>/`. Include only verified PDFs with neutral names and a minimal versioned manifest: release ID, document IDs, output names, hashes, page counts, export-profile ID and non-sensitive check outcomes. The publication service constructs an allowlist and rejects extra files. Never copy working folders wholesale or include original filenames, local paths, search terms, removed text, private plans, thumbnails or internal audit databases.

The private release record retains detailed provenance, exclusions, reviewer decisions and timestamps. A shareable manifest is a separate schema and should reveal only what the recipient needs. The user previews the output filenames and manifest before release.

Older releases stay historically identifiable when new revisions are created. Mark superseded/withdrawn releases in private case state, show that status prominently and default sharing actions to the current selected release. The app cannot revoke copies already sent outside the working folder. Recheck hashes before app-mediated copy/export; discrepancies disable sharing actions and require investigation.

## Alternatives and consequences

- Saving attachments beside a redacted parent is convenient but can release untouched originals.
- Requiring the whole case to be complete prevents intentional smaller releases. Frozen selections give a precise and testable boundary.
- Replacing the last export destroys the record of what was shared. New release IDs require more storage and clearer UI.

## Acceptance evidence

- A redacted email with an unreadable or unresolved attachment cannot pass its family gate.
- An explicitly excluded attachment is visible in the private release summary and absent from the package.
- Nested and inline items retain accountable parent relationships without leaking raw assets.
- Folder/file names and manifest content contain no synthetic sensitive source names or paths.
- One failed selected member produces no published package; a new deliberate smaller selection can succeed.
- Editing or withdrawing a release never silently rewrites its previously published bytes.
