# Contributing

Use Node 24 LTS and the pnpm version pinned in `packageManager`. Commit `pnpm-lock.yaml`; do not add npm/yarn lockfiles. Install with `pnpm install --frozen-lockfile`. Direct dependencies are pinned, releases have a one-day cooldown, lifecycle builds use an explicit allowlist, and peer resolution is strict. Review exceptions before changing the supply-chain policy.

The [Linux development and handoff guide](docs/linux-development.md) covers Fedora ARM64 in a desktop VM, source transfer, runtime setup and native verification. Reinstall dependencies on the target OS; do not transfer macOS dependency/build directories.

Run `pnpm check` before a change is ready for review. Tests create synthetic data in OS temp directories and must never require real mail. E2E tests launch actual Electron windows and PDF printers; a passing parser unit test alone is not evidence that production bundles work. Linux needs a graphical session/Xvfb. Windows build/test requires the MSVC C++ tools for the optional Office isolation broker. `MSG2PDF_TEST_OFFICE` adds a real Office conversion test when a supported installation is available.

Keep the core independent of Electron/React, use strict types and runtime validation at external boundaries, handle cancellation and release temporary resources in `finally`, and keep stdout machine-readable for `--json`. Do not add general filesystem/shell bridges, load remote renderer code, disable sandboxing, or fetch remote email resources. New parsing/printing dependencies need a licensing and security review.

Biome handles formatting, imports, recommended correctness/accessibility rules and explicit `any`/unsafe HTML restrictions. The CSS specificity ordering rule is narrowly suppressed for the component stylesheet because its unrelated component subtrees are intentionally grouped. Reduced-motion declarations use narrowly explained `!important` exceptions to enforce accessibility. Do not add unexplained suppressions or blanket-disable safety checks.

Regenerate third-party notices with `pnpm run licenses:generate` after dependency changes. `pnpm audit:production` checks published runtime advisories. Inspect packaged artifacts with `pnpm test:packaged`; source maps, development dependencies and test fixtures must be absent. Installer builds never publish automatically. Original msg2pdf code and documentation use Apache-2.0; contributions are submitted under that licence unless explicitly stated otherwise. Preserve project LICENSE/NOTICE and third-party licence notices in distributions.
