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
