//! Exercises the S3 client against a test server (e.g. `moto_server -p 5055`):
//!   cargo run -p dogfile-backend --no-default-features --example s3_check -- http://127.0.0.1:5055
use dogfile_backend::s3::S3;
use serde_json::json;
use sha2::{Digest, Sha256};

fn sha(p: &std::path::Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(p).unwrap()))
}
#[tokio::main]
async fn main() {
    let ep = std::env::args().nth(1).unwrap_or("http://127.0.0.1:5055".into());
    let s3 = S3::from(&json!({ "host": ep, "bucket": "", "user": "testing", "region": "us-east-1", "maxSpeed": "" }), "testing").unwrap();
    let dir = std::env::temp_dir().join("s3check");
    let _ = std::fs::create_dir_all(&dir);
    let small = dir.join("small.txt");
    std::fs::write(&small, "hello world").unwrap();
    let big = dir.join("big.bin");
    let mut data = vec![0u8; 70 * 1024 * 1024 + 12345];
    for (i, b) in data.iter_mut().enumerate() { *b = (i * 7 % 251) as u8; }
    std::fs::write(&big, &data).unwrap();
    let step = |name: &str, r: Result<(), String>| { println!("{} {name}{}", if r.is_ok() { "ok  " } else { "FAIL" }, r.err().map(|e| format!(": {e}")).unwrap_or_default()); };
    step("make bucket", s3.mkdir("/photos").await);
    let b = s3.list("/").await.map(|v| v.iter().map(|e| e.name.clone()).collect::<Vec<_>>());
    println!("buckets: {b:?}");
    step("mkdir", s3.mkdir("/photos/2026").await);
    step("upload small", s3.upload(&small, "/photos/2026/small.txt", &mut |_| {}).await);
    let mut last = 0;
    let t = std::time::Instant::now();
    step("upload big (multipart)", s3.upload(&big, "/photos/2026/big.bin", &mut |n| last = n).await);
    println!("     progress reached {last} of {} in {:?}", data.len(), t.elapsed());
    let l = s3.list("/photos/2026").await.unwrap();
    println!("list: {:?}", l.iter().map(|e| (e.name.clone(), e.is_dir, e.size)).collect::<Vec<_>>());
    println!("stat big: {:?}  stat folder: {:?}  stat missing: {:?}", s3.stat("/photos/2026/big.bin").await, s3.stat("/photos/2026").await, s3.stat("/photos/nope").await);
    step("copy folder (server side)", s3.copy("/photos/2026", "/photos/2026-copy").await);
    step("rename file", s3.rename("/photos/2026-copy/small.txt", "/photos/2026-copy/renamed.txt").await);
    println!("list copy: {:?}", s3.list("/photos/2026-copy").await.unwrap().iter().map(|e| (e.name.clone(), e.size)).collect::<Vec<_>>());
    let back = dir.join("back.bin");
    step("download big", s3.download("/photos/2026-copy/big.bin", &back, &mut |_| {}).await);
    println!("     same bytes: {}", sha(&back) == sha(&big));
    step("remove folder", s3.remove("/photos/2026-copy").await);
    println!("after remove: {:?}", s3.list("/photos").await.unwrap().iter().map(|e| e.name.clone()).collect::<Vec<_>>());
    step("remove all", s3.remove("/photos").await);
    println!("buckets now: {:?}", s3.list("/").await.map(|v| v.len()));
    let one = S3::from(&json!({ "host": ep, "bucket": "nope-bucket", "user": "testing" }), "testing").unwrap();
    println!("missing bucket: {:?}", one.list("/").await.err());
}
