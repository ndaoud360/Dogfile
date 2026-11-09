# Dogfile combined patch (1 + 2 + 2B) — fixed build

Extract this ZIP into the Dogfile repository root and replace the 17 files (backend/ and src/renderer/).
Do not apply the old .patch file on top; this ZIP already includes everything.

## Fixes
1. backend/src/fsx.rs (line 205): doubled backslashes in the "already exists" message broke the Rust build
   (error: unknown start of token: \). Now matches mkdir's working version.
2. backend/src/pro_media.rs: a failed image/GIF encode now deletes the half-written output file
   instead of leaving an empty file beside the original.
3. src/renderer/js/protools.js: background-removal mask is now min-max normalised per image
   (the ISNet model card requires this) before it becomes the PNG's alpha channel.

## Known limits (unchanged)
- WebP output is lossless only (image crate); the quality slider affects JPG only.
- Not compiled here; build via your normal Windows CI and smoke-test the model downloads.
- Your repo's commit 7276a61 reverted the wiring in 14 files; extracting this ZIP restores it.

## Fix 4 (CI)
src/renderer/js/protools.js: build/test-renderer.mjs requires the literal text requirePro('proUtilities') in the source.
The helper now calls requirePro('proUtilities') directly. Renderer tests: 1567 passed, 0 failed; ESLint undef check clean.

## Fix 5 — PSD helper deployment and ribbon empty state
- `backend/build.rs` now watches every `DOGFILE_*` build-time variable used by `option_env!`. Cached Cargo builds therefore rebuild the backend when the PSD download URL and checksum change; previously a cached backend could keep an empty URL even though CI had created the helper ZIP.
- `build/package-win.mjs` now accepts `--psd <dogfile-psd.zip>` and installs the helper into `dist/Dogfile/psd/`. The Windows setup and Microsoft Store packages include the helper next to Dogfile, so the layered editor works on first open without relying on a component download. The checksum-verified component download remains a fallback for standalone/update builds.
- The Windows workflow passes the helper archive to packaging and has a separate, mandatory check that the final packaged helper starts successfully.
- The backend prefers the helper bundled beside Dogfile and only falls back to the downloaded component. PSD component readiness also verifies that the expected executable actually exists.
- The PSD contextual ribbon no longer shows inactive Fit/Zoom controls while no PSD is open.

Validation: package staging was exercised with a test ZIP containing a mock helper and runtime folder; the resulting `dist/Dogfile/psd` layout was correct. Renderer suites: 1,645 + 48 + 200 tests passed. Workflow YAML and JavaScript syntax checks passed. A Rust compile and real Windows/PyInstaller helper execution could not be run in this environment (Cargo/Rust are not installed here).
