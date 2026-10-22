// Runs Dogfile's back end with the interface served over HTTP, for development and automated tests:
//   dogfile-dev [address] [renderer dir] [data dir]
use std::path::PathBuf;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let addr = args.get(1).cloned().unwrap_or("127.0.0.1:47800".into());
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let renderer = args.get(2).map(PathBuf::from).unwrap_or(root.join("src").join("renderer"));
    let data = args.get(3).map(PathBuf::from).unwrap_or(std::env::temp_dir().join("dogfile-dev-data"));
    let host = dogfile_backend::server::DevHost::new();
    dogfile_backend::start(dogfile_backend::Config { data_dir: data, renderer_dir: renderer, ui_pak: std::env::var("DOGFILE_TEST_PAK").ok().and_then(|f| std::fs::read(f).ok()).map(|b| &*Box::leak(b.into_boxed_slice())), res_dir: root.clone(), test_mode: true }, host.clone());
    println!("Dogfile dev server on http://{addr}/app/index.html");
    if let Err(e) = dogfile_backend::server::serve_dev(host, &addr).await {
        eprintln!("{e}");
    }
}
