// Music tags: read / write ID3, Vorbis comments, MP4 atoms and RIFF INFO through ffmpeg (cover art too), labels
// on any media file, and free online lookups (iTunes Search, MusicBrainz / Cover Art Archive, AcoustID).
use crate::args::{Args, R};
use crate::media::{ffmpeg, probe};
use crate::util::{self, basename};
use serde_json::{json, Map, Value};
use std::time::Duration;

const COVER_OK: [&str; 7] = ["mp3", "flac", "m4a", "mp4", "aac", "alac", "m4b"];

pub async fn read(a: &Args) -> R {
    let file = a.s(0)?;
    let info = probe(&file).await?;
    let mut raw: Map<String, Value> = info["format"]["tags"].as_object().cloned().unwrap_or_default();
    for s in info["streams"].as_array().cloned().unwrap_or_default() {
        if s["codec_type"] == "audio" {
            if let Some(t) = s["tags"].as_object() {
                for (k, v) in t {
                    if !raw.contains_key(k) { raw.insert(k.clone(), v.clone()); }
                }
            }
        }
    }
    let lower: Map<String, Value> = raw.into_iter().map(|(k, v)| (k.to_lowercase(), v)).collect();
    let g = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(v) = lower.get(*k) {
                let s = match v { Value::String(s) => s.clone(), o => o.to_string() };
                if !s.is_empty() { return s }
            }
        }
        String::new()
    };
    let ext = util::ext(&file);
    Ok(json!({
        "tags": {
            "title": g(&["title", "inam"]), "artist": g(&["artist", "iart"]), "album": g(&["album", "iprd"]), "album_artist": g(&["album_artist", "albumartist", "album artist"]),
            "date": g(&["date", "year", "icrd", "tyer", "tdrc"]), "track": g(&["track", "tracknumber", "itrk"]), "disc": g(&["disc", "discnumber"]), "genre": g(&["genre", "ignr"]),
            "composer": g(&["composer"]), "comment": g(&["comment", "icmt", "description"]), "bpm": g(&["tbpm", "bpm"]), "key": g(&["tkey", "initialkey", "key"]),
        },
        "hasCover": info["streams"].as_array().map(|ss| ss.iter().any(|s| s["disposition"]["attached_pic"].as_i64().unwrap_or(0) != 0)).unwrap_or(false),
        "coverSupported": COVER_OK.contains(&ext.as_str()),
        "duration": info["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0),
        "format": info["format"]["format_name"].as_str().unwrap_or(""),
    }))
}

async fn ff(args: Vec<String>, timeout: u64) -> Result<(), String> {
    let o = util::run(ffmpeg(), &args, None, timeout).await.map_err(|e| e.to_string())?;
    if o.ok {
        Ok(())
    } else {
        let l = util::last_line(&o.err());
        Err(if l.is_empty() { "ffmpeg failed".into() } else { l })
    }
}
async fn replace_retry(tmp: &str, file: &str) -> Result<(), String> {
    for _ in 0..20 {
        if std::fs::rename(tmp, file).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = std::fs::remove_file(tmp);
    Err("The file is in use (is it playing?). Close it and try again.".into())
}

/// changes: only changed fields ('' clears). cover: missing = keep, null = remove, data URL = replace
pub async fn write(a: &Args) -> R {
    let file = a.s(0)?;
    let changes = a.v(1);
    let cover = a.0.get(2).cloned();
    let e = util::ext(&file);
    let out = util::join(&util::dirname(&file), &format!(".{}.atlas-tag.{e}", basename(&file)));
    let tmp_dir = util::temp_dir("tag").map_err(|e| e.to_string())?;
    let r: Result<(), String> = async {
        let mut args: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", &file].iter().map(|s| s.to_string()).collect();
        let mut cover_file = None;
        if let Some(Value::String(c)) = &cover {
            if c.starts_with("data:image/") {
                if !COVER_OK.contains(&e.as_str()) {
                    return Err(format!(".{e} files can't store cover art. Convert to MP3, FLAC or M4A to add one."));
                }
                let png = c.starts_with("data:image/png");
                let data = c.split_once(',').map(|x| x.1).unwrap_or("");
                let f = tmp_dir.join(if png { "cover.png" } else { "cover.jpg" });
                std::fs::write(&f, util::unb64(data)?).map_err(|e| e.to_string())?;
                args.extend(["-i".into(), f.to_string_lossy().into_owned()]);
                cover_file = Some(f);
            }
        }
        args.extend(["-map".into(), "0:a".into()]);
        if cover_file.is_some() {
            args.extend(["-map".into(), "1:0".into()]);
        } else if cover != Some(Value::Null) && COVER_OK.contains(&e.as_str()) {
            args.extend(["-map".into(), "0:v?".into()]);
        }
        args.extend(["-c", "copy", "-map_metadata", "0"].iter().map(|s| s.to_string()));
        if cover_file.is_some() {
            args.extend(["-disposition:v:0", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"].iter().map(|s| s.to_string()));
        }
        let id3 = e == "mp3";
        if let Some(m) = changes.as_object() {
            for (k, v) in m {
                let key = match k.as_str() {
                    "bpm" => if id3 { "TBPM" } else if e == "m4a" { "tmpo" } else { "BPM" },
                    "key" => if id3 { "TKEY" } else { "INITIALKEY" },
                    o => o,
                };
                let val = match v { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() };
                args.extend(["-metadata".into(), format!("{key}={val}")]);
            }
        }
        if id3 {
            args.extend(["-id3v2_version", "3", "-write_id3v1", "1"].iter().map(|s| s.to_string()));
        }
        if e == "wav" {
            args.extend(["-write_bext".into(), "0".into()]);
        }
        args.push(out.clone());
        ff(args, 120000).await?;
        replace_retry(&out, &file).await
    }
    .await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let _ = std::fs::remove_file(&out);
    r.map(|_| json!(true))
}

/// title / artist / comment on any media file (videos too): streams copied, only the labels change
pub async fn write_media(a: &Args) -> R {
    let file = a.s(0)?;
    let changes = a.v(1);
    let e = util::ext(&file);
    let out = util::join(&util::dirname(&file), &format!(".{}.dogfile-meta.{e}", basename(&file)));
    let mut args: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", &file, "-map", "0", "-c", "copy", "-map_metadata", "0"].iter().map(|s| s.to_string()).collect();
    if let Some(m) = changes.as_object() {
        for (k, v) in m {
            args.extend(["-metadata".into(), format!("{k}={}", v.as_str().unwrap_or(""))]);
        }
    }
    if ["mp4", "m4v", "mov"].contains(&e.as_str()) {
        args.extend(["-movflags".into(), "use_metadata_tags".into()]);
    }
    args.push(out.clone());
    let r = async {
        ff(args, 300000).await?;
        replace_retry(&out, &file).await
    }
    .await;
    let _ = std::fs::remove_file(&out);
    r.map(|_| json!(true))
}

async fn get_json(url: &str) -> Result<Value, String> {
    let r = util::http().get(url).header("Accept", "application/json").timeout(Duration::from_secs(12)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status().as_u16()));
    }
    r.json().await.map_err(|e| e.to_string())
}
fn credit(a: &Value) -> String {
    a.as_array().map(|l| l.iter().map(|x| format!("{}{}", x["name"].as_str().unwrap_or(""), x["joinphrase"].as_str().unwrap_or(""))).collect::<String>()).unwrap_or_default()
}
pub async fn lookup(a: &Args) -> R {
    let q = a.v(0);
    let s = |k: &str| q[k].as_str().unwrap_or("").to_string();
    let (title, artist) = (s("title"), s("artist"));
    let term = if !s("query").is_empty() { s("query") } else { [artist.clone(), title.clone()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" ") };
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(json!([]));
    }
    let itunes = format!("https://itunes.apple.com/search?media=music&entity=song&limit=12&term={}", urlencoding::encode(&term));
    let mbq = if !title.is_empty() { format!("recording:\"{}\"{}", title.replace('"', ""), if artist.is_empty() { String::new() } else { format!(" AND artist:\"{}\"", artist.replace('"', "")) }) } else { term.clone() };
    let mb = format!("https://musicbrainz.org/ws/2/recording/?fmt=json&limit=8&query={}", urlencoding::encode(&mbq));
    let (a1, a2) = tokio::join!(get_json(&itunes), get_json(&mb));
    let mut out = vec![];
    if let Ok(j) = a1 {
        for r in j["results"].as_array().cloned().unwrap_or_default() {
            let tn = r["trackNumber"].as_u64();
            out.push(json!({
                "source": "iTunes", "title": r["trackName"].as_str().unwrap_or(""), "artist": r["artistName"].as_str().unwrap_or(""), "album": r["collectionName"].as_str().unwrap_or(""),
                "album_artist": r["collectionArtistName"].as_str().or(r["artistName"].as_str()).unwrap_or(""), "date": r["releaseDate"].as_str().unwrap_or("").chars().take(4).collect::<String>(),
                "genre": r["primaryGenreName"].as_str().unwrap_or(""), "track": tn.map(|n| format!("{n}{}", r["trackCount"].as_u64().map(|c| format!("/{c}")).unwrap_or_default())).unwrap_or_default(),
                "disc": r["discNumber"].as_u64().map(|d| d.to_string()).unwrap_or_default(), "art": r["artworkUrl100"].as_str().unwrap_or("").replace("100x100bb", "600x600bb"),
                "thumb": r["artworkUrl100"].as_str().unwrap_or(""), "duration": r["trackTimeMillis"].as_f64().map(|m| m / 1000.0).unwrap_or(0.0),
            }));
        }
    }
    if let Ok(j) = a2 {
        for r in j["recordings"].as_array().cloned().unwrap_or_default() {
            let rels = r["releases"].as_array().cloned().unwrap_or_default();
            let rel = rels.iter().find(|x| x["status"] == "Official").or(rels.first()).cloned();
            let rel_ac = rel.as_ref().map(|x| x["artist-credit"].clone()).filter(|v| v.is_array()).unwrap_or(r["artist-credit"].clone());
            out.push(json!({
                "source": "MusicBrainz", "title": r["title"].as_str().unwrap_or(""), "artist": credit(&r["artist-credit"]), "album": rel.as_ref().and_then(|x| x["title"].as_str()).unwrap_or(""),
                "album_artist": credit(&rel_ac), "date": rel.as_ref().and_then(|x| x["date"].as_str()).or(r["first-release-date"].as_str()).unwrap_or("").chars().take(4).collect::<String>(), "genre": "",
                "track": rel.as_ref().and_then(|x| x["media"][0]["track"][0]["number"].as_str()).unwrap_or(""), "disc": "",
                "art": rel.as_ref().and_then(|x| x["id"].as_str()).map(|id| format!("https://coverartarchive.org/release/{id}/front-500")).unwrap_or_default(),
                "thumb": rel.as_ref().and_then(|x| x["id"].as_str()).map(|id| format!("https://coverartarchive.org/release/{id}/front-250")).unwrap_or_default(),
                "duration": r["length"].as_f64().map(|l| l / 1000.0).unwrap_or(0.0), "mbid": r["id"],
            }));
        }
    }
    Ok(json!(out))
}

/// audio fingerprint -> AcoustID -> MusicBrainz recordings (needs a free AcoustID application key)
pub async fn identify(a: &Args) -> R {
    let file = a.s(0)?;
    let key = a.s_or(1, "");
    if key.trim().is_empty() {
        return Err("Add your free AcoustID key in Settings > Tools & apps to identify songs by sound.".into());
    }
    let tmp = std::env::temp_dir().join(format!("dogfile-fp-{}.txt", util::now_ms() as u64));
    let tp = tmp.to_string_lossy().into_owned();
    let r: R = async {
        ff(["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", &file, "-t", "120", "-ac", "1", "-f", "chromaprint", "-fp_format", "base64", &tp].iter().map(|s| s.to_string()).collect(), 60000).await?;
        let fp = std::fs::read_to_string(&tmp).unwrap_or_default().trim().to_string();
        if fp.len() < 20 {
            return Err("Could not fingerprint this file (is the audio long enough?)".into());
        }
        let dur = probe(&file).await.ok().and_then(|i| i["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok())).map(|d| d.round() as u64).filter(|d| *d > 0).unwrap_or(120);
        let form = [("client", key.trim().to_string()), ("format", "json".into()), ("meta", "recordings releasegroups compress".into()), ("duration", dur.to_string()), ("fingerprint", fp)];
        let resp = util::http().post("https://api.acoustid.org/v2/lookup").header("Accept", "application/json").form(&form).timeout(Duration::from_secs(20)).send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let j: Value = resp.json().await.map_err(|_| format!("AcoustID answered HTTP {status}"))?;
        if j["status"] != "ok" {
            let code = j["error"]["code"].as_i64();
            let msg = j["error"]["message"].as_str().unwrap_or("AcoustID lookup failed");
            if code == Some(4) || msg.to_lowercase().contains("api key") {
                return Err("AcoustID rejected the key. Lookups need an application API key: sign in at acoustid.org, choose “Register a new application” (free), and paste that key in Settings > Tools & apps. The key shown on your account page is a user key and won’t work here.".into());
            }
            return Err(format!("AcoustID: {msg}"));
        }
        let mut results = j["results"].as_array().cloned().unwrap_or_default();
        results.sort_by(|a, b| b["score"].as_f64().unwrap_or(0.0).partial_cmp(&a["score"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
        let mut out = vec![];
        for r in results {
            let score = r["score"].as_f64().unwrap_or(0.0);
            for rec in r["recordings"].as_array().cloned().unwrap_or_default() {
                let rg = rec["releasegroups"][0].clone();
                let rgid = rg["id"].as_str().map(String::from);
                out.push(json!({ "source": format!("AcoustID {}%", (score * 100.0).round()), "title": rec["title"].as_str().unwrap_or(""), "artist": credit(&rec["artists"]),
                    "album": rg["title"].as_str().unwrap_or(""), "album_artist": "", "date": "", "genre": "", "track": "", "disc": "",
                    "art": rgid.as_ref().map(|id| format!("https://coverartarchive.org/release-group/{id}/front-500")).unwrap_or_default(),
                    "thumb": rgid.as_ref().map(|id| format!("https://coverartarchive.org/release-group/{id}/front-250")).unwrap_or_default(), "mbid": rec["id"], "score": score }));
            }
        }
        out.truncate(15);
        Ok(json!(out))
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    r
}

/// cover art from the services above, as a data URL
pub async fn fetch_art(a: &Args) -> R {
    let url = a.s(0)?;
    if !regex::Regex::new(r"(?i)^https://([a-z0-9-]+\.)*(mzstatic\.com|coverartarchive\.org|archive\.org)/").unwrap().is_match(&url) {
        return Err("Unsupported image source".into());
    }
    let r = util::http().get(&url).timeout(Duration::from_secs(30)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("No cover art ({})", r.status().as_u16()));
    }
    let ctype = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").split(';').next().unwrap_or("image/jpeg").to_string();
    if !ctype.starts_with("image/") {
        return Err("Not an image".into());
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    if b.len() > 15 * 1024 * 1024 {
        return Err("Image too large".into());
    }
    Ok(json!(format!("data:{ctype};base64,{}", util::b64(&b))))
}
