fn main() {
    // the packed interface (node build/pack-ui.mjs) is compiled into the program when it's there;
    // without it, the program uses the interface folder beside it or in the source tree (development)
    let pak = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen").join("ui.pak");
    println!("cargo::rustc-check-cfg=cfg(ui_pak)");
    println!("cargo:rerun-if-changed=gen");
    if pak.exists() {
        println!("cargo:rerun-if-changed={}", pak.display());
        println!("cargo:rustc-cfg=ui_pak");
        println!("cargo:rustc-env=DOGFILE_UI_PAK={}", pak.display());
    }
    tauri_build::build()
}
