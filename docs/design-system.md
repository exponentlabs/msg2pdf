# Atlas Graphite glass adoption

The visual reference is the Atlas operating model studio in `exponent-labs/atlas`, particularly `src/theme.css` and the Graphite glass screenshots under `docs/`. The owner selected Graphite glass over Atlas's Ink & Ivory alternative and authorised adaptations to retain msg2pdf's existing layout and functionality.

## Visual roles

`src/renderer/tokens.css` defines Atlas-derived typography, graphite surfaces, purple emphasis, orange actions, border/hover/focus treatments and glass shadows. `src/renderer/styles.css` applies those roles to the existing converter shell, file queue, destination/options panels, preview dialog, activity and settings. Layout and product actions remain owned by msg2pdf.

The palette uses Atlas's dark canvas (`#19171b`), purple emphasis (`#bea2ff`) and orange action gradient (`#ffba7b` to `#f79b55`). Translucent panels sit over the same restrained purple/orange atmosphere as the reference. Purple marks selection and active controls; orange marks primary actions. Green, amber and pink retain operational success/warning/error meanings.

Poppins is locally bundled at weights 400, 500, 600 and 700. Native monospaced fallbacks distinguish compact file details, annotations and keyboard hints. Smaller secondary text has been made more readable while retaining the two-column workspace, persistent navigation and footer. The preview has a dark application frame and a white document surface so email content remains readable in its print context.

Focus indicators, disabled states, label associations and reduced-motion behaviour are retained. Reduced-transparency preferences use opaque graphite surfaces without backdrop filtering. The window's native appearance, launch background and app icon match the dark theme.

Keep prefixed backdrop-filter declarations before the unprefixed property. The production CSS minifier can otherwise retain only the WebKit-prefixed declaration, which Chromium ignores. The desktop integration test checks the built CSS with normal and reduced-transparency media preferences so both material treatments remain functional.

## Portable snapshot and attribution

The adapted theme and unmodified font files are included in this repository, so builds do not depend on the Atlas checkout, an external package registry for theme code, or a font CDN. `resources/fonts/Poppins-provenance.json` records source references and SHA-256 hashes. `resources/fonts/Poppins-OFL.txt` preserves the original copyright and SIL Open Font License. The build's third-party notices include the font snapshot alongside locked package dependencies. Project licensing remains pending owner review.

When refining appearance, change semantic roles in `tokens.css` first. Keep product geometry and responsive rules in `styles.css`. Scope semantic status colours to states. Review the converter, empty/queued/completed states, preview, activity, settings and minimum 980 × 720 window before releasing a visual update.

## Validation

The Electron integration suite captures `artifacts/desktop-initial.png`, `desktop-queue.png`, `desktop-preview.png`, `desktop-complete.png`, `desktop-activity.png`, `desktop-settings.png` and `desktop-compact.png`. It exercises real conversion, attachments, reports, preview isolation, history and configuration controls, and checks horizontal overflow at the minimum window size. Existing terminal, cancellation and safe-shutdown checks continue to exercise the shared engine.

This visual adoption was checked with strict TypeScript, Biome, the existing unit suite and real Electron integration tests. The optional LibreOffice integration test requires a local installation; its earlier rewrite validation is recorded in `verification.md`.
