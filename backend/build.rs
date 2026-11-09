// The downloadable component URLs and checksums are injected by the Windows build workflow.
// `option_env!` is evaluated by rustc, but Cargo does not otherwise know those values affect
// this crate. Watch them explicitly so a cached build cannot retain an older binary with empty
// component URLs after the workflow has generated new helper packages.
fn main() {
    for name in [
        "DOGFILE_FFMPEG_URL",
        "DOGFILE_FFMPEG_SHA256",
        "DOGFILE_FFMPEG_SIZE",
        "DOGFILE_OCR_URL",
        "DOGFILE_OCR_SHA256",
        "DOGFILE_OCR_SIZE",
        "DOGFILE_ORT_URL",
        "DOGFILE_ORT_SHA256",
        "DOGFILE_ORT_SIZE",
        "DOGFILE_PSD_URL",
        "DOGFILE_PSD_SHA256",
        "DOGFILE_PSD_SIZE",
        "DOGFILE_LLAMA_URL",
        "DOGFILE_LLAMA_SHA256",
        "DOGFILE_DROPBOX_CLIENT_ID",
        "DOGFILE_GDRIVE_CLIENT_ID",
        "DOGFILE_GDRIVE_CLIENT_SECRET",
        "DOGFILE_ONEDRIVE_CLIENT_ID",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
}
