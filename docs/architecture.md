# Architecture and rewrite plan

The Python implementation is archived under `legacy/python`. The active app is a strict TypeScript application with a shared conversion core, isolated Electron processes, and a bundled terminal launcher. It performs no background network requests.

## Layers

```text
React GUI → sandboxed preload → validated IPC → main-process controller
Terminal launcher → Electron CLI controller ─┘
                         ↓
                 shared conversion engine
           discovery → planning → sequential execution
                    ↓          ↓           ↓
              utility parser  PDF window  Office sandbox
                         ↓
             atomic output + structured summary
```

`src/shared` defines contracts and schemas. `src/core` owns portable names, traversal, MIME/MSG normalization, sanitized documents, output writes, subprocess limits and conversion orchestration. It has no Electron or React dependencies. Services inject parsing, PDF printing and Office conversion so the same engine can be tested independently.

`src/main` owns native dialogs, granted-path capabilities, application settings, worker lifecycles and IPC. `src/preload` exposes only named operations. Renderer input/output identifiers refer to main-owned selections; arbitrary filesystem paths are never accepted by conversion/reveal IPC. Every invocation checks its sender, main-frame status and custom-scheme origin before validating its payload.

Email parsing runs in a fresh utility process with a 30-second deadline, a V8 heap limit, and working-set monitoring. MSG/EML parsing includes legacy HTML encodings, MIME attachments, embedded MSG data and CID images. Referenced/linked attachments are not resolved. Encapsulated RTF uses a bounded decompressor/parser. Email HTML receives an allowlist sanitizer before preview or printing.

PDFs are printed in hidden Chromium windows with JavaScript/Node disabled, sandboxing enabled, no popup/navigation permissions, and all file/network requests denied. A single private nonpersistent session avoids accumulating a session per message; each renderer is destroyed and session storage cleared after its job. Preview iframes have an empty sandbox attribute and cannot call the desktop bridge.

Office files run through an optional, separately installed LibreOffice with a disposable profile, macros disabled, external link updates disabled, a time/memory budget and OS isolation: macOS Seatbelt, Linux bubblewrap, Windows AppContainer plus Job Object. Missing/unsupported sandbox prerequisites fail explicitly. The Windows broker is statically linked C++ and contains no third-party runtime.

On macOS, Office uses a short private workspace and redirects its instance IPC socket there. The policy allows AF_UNIX bind/connect only inside that workspace; TCP/IP remains denied. This avoids relying on LibreOffice's shared `/tmp` instance socket and stays within macOS's Unix socket path limit. Canonical paths are used in the policy because macOS temporary paths commonly contain `/var` → `/private/var` aliases.

The CLI bootstrap runs in the packaged Electron Node runtime, starts an isolated Electron conversion process, and renders the same structured events as plain terminal progress or one JSON summary. It does not need system Node. GUI and CLI jobs use output-directory locks to prevent competing overwrites. Files are staged privately and committed with rename (overwrite) or an exclusive hard link (skip existing). Attachments share the output name allocator with top-level PDFs.

## Implementation plan

1. Replace active Python metadata/CI with pinned pnpm, strict TypeScript, Biome and reproducible bundles; retain legacy for reference only.
2. Implement portable discovery/planning, MSG/EML normalization, safe attachments, atomic writes and structured results.
3. Build the isolated Electron controller, native file capabilities, optional LibreOffice configuration and shared CLI.
4. Build the local React workbench: real queue/preview/options, cancellation, recent activity and report export.
5. Package app-owned runtime, launchers, icon, third-party notices and Windows Office broker; configure OS-specific installers.
6. Verify naming/security/error paths with independent synthetic fixtures, real Electron GUI/CLI conversions, and packaged-app smoke tests. Run OS-specific CI on native runners before distributing each platform.

## Deliberate tradeoffs

Sequential execution bounds peak memory, preserves deterministic attachment names and simplifies cancellation. The queue displays 40 entries per page. The engine caps file count and byte sizes; activity persists only a bounded subset of results. Full reports remain available explicitly.

Email styles are simplified for predictable print layout and safety. The app is a converter, not an Outlook renderer or S/MIME trust validator. Office layout depends on installed fonts and LibreOffice's import filters. Electron CLI conversion requires a display server on Linux; `xvfb-run` provides one in CI/headless environments.

The terminal launcher intentionally keeps the RunAsNode fuse enabled. Node options and CLI inspector fuses are disabled, custom-protocol privileges are restricted, and packaged app loading is confined to ASAR. macOS/Windows enable ASAR integrity validation. This tradeoff requires a trusted local installation and should be reassessed if the CLI design changes.

## Validation boundaries

Use `pnpm check` for source checks and real Electron tests. Use `pnpm package:dir && pnpm test:packaged` for the current platform. `MSG2PDF_TEST_OFFICE` enables a real optional Office conversion integration test against a current local executable. Packaging configuration/CI alone is not proof that another OS has passed; native runner results and release signing are separate requirements.
