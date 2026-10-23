// Every call the window can make, by name (the same names the Electron version used).
use crate::args::{Args, R};
use crate::host::DialogOpts;
use crate::util;
use crate::*;
use serde_json::{json, Value};

pub const NAMES: &[&str] = &[
    "license:status", "llm:status", "llm:warm", "llm:plan", "llm:stop", "reminders:list", "reminders:status", "reminders:apply", "reminders:scanNow", "reminders:analyze", "reminders:add", "reminders:update", "reminders:snooze", "reminders:remove", "reminders:test", "license:startTrial", "license:activate", "license:offlineRequest", "license:offlineApply", "license:deactivate", "license:checkout", "license:claim", "license:refresh",
    "sys:info", "fs:list", "fs:subdirs", "fs:stat", "fs:exists", "fs:isDir", "fs:mkdir", "fs:newFile", "fs:rename", "fs:uniqueName", "fs:readText", "fs:readBytes", "fs:compareBinary", "fs:writeText", "fs:writeImage", "fs:hash",
    "fs:attributes", "fs:setAttributes", "fs:setTimes", "fs:symlink", "fs:shortcut", "fs:readLink", "fs:drives", "fs:eject", "fs:mapped", "fs:recentWindows", "fs:statMany", "thumb:get", "icon:get",
    "shell:open", "shell:openExternal", "shell:openWith", "shell:runAs", "shell:showInExplorer", "shell:terminal", "shell:properties", "shell:verbs", "shell:invokeVerb", "shell:beep", "shell:launch",
    "shell:runCommand", "fs:findUnder", "sys:findEditor", "clip:writeFiles", "clip:readFiles", "clip:writeText", "clip:readText", "clip:hasImage", "clip:formats", "clip:watch", "ops:start",
    "shell:wallpaper", "archive:test", "archive:caps", "ops:control", "ops:list", "ops:configure", "ops:resolveConflict", "archive:list", "work:start", "work:cancel", "index:status", "index:configure",
    "index:refresh", "index:search", "index:sizes", "index:fastBuild", "core:info", "everything:search", "everything:available", "everything:status", "git:branches", "git:checkout", "git:log", "git:pull",
    "git:status", "recycle:list", "recycle:restore", "recycle:restoreOriginal", "recycle:deleteForever", "recycle:empty", "watch:set", "rules:watch", "remote:list", "remote:signIn", "remote:get", "remote:put",
    "remote:remove", "remote:rename", "remote:copy", "remote:mkdir", "remote:open", "remote:test", "remote:setSecret", "remote:disconnect", "net:connectShare", "net:unc", "net:reachable", "net:status", "cloud:detect",
    "ext:fetch", "docs:featureGuide", "ext:log", "ext:logs", "ext:clearLogs", "ext:install", "secret:set", "secret:has", "gh:request", "meta:status", "meta:install", "m3d:cadStatus", "m3d:cadInstall", "m3d:dwgStatus", "m3d:dwgToDxf", "phone:status", "phone:start", "phone:stop", "phone:pair", "phone:forget", "phone:rename", "phone:send", "phone:sendText", "phone:unsend", "meta:read", "meta:write", "meta:stripGps", "meta:stripAll", "meta:streams", "meta:streamsMany", "meta:streamRead", "meta:streamWrite", "meta:streamRemove", "doc:read", "doc:text", "doc:titles", "doc:setProps", "media:setMeta",
    "versions:save", "versions:list", "versions:restore", "versions:remove", "versions:overview", "versions:track", "watched:add", "watched:get", "store:get", "store:set", "store:path", "default:get",
    "default:set", "win:new", "win:control", "win:overlay", "win:zoom", "theme:get", "dialog:pickFolder", "dialog:openFiles", "dialog:saveFile", "dialog:confirm", "tool:open", "tool:pending", "media:probe",
    "media:imgMeta", "media:quickProbe", "media:sheetCancel", "media:contactSheet", "media:encoder", "media:shotDir", "media:export", "ai:status", "ai:download", "ai:remove", "ai:cacheGet", "ai:cacheSet",
    "tags:read", "tags:write", "keywords:read", "keywords:write", "tags:lookup", "tags:identify", "tags:fetchArt", "media:job", "media:cancel", "fs:trash", "fs:copyFile", "fs:writeDataUrl", "fs:readBuffer", "fs:writeEncoded",
    "archive:watchEdit", "fs:watchFile", "mtp:list", "mtp:copyOut", "mtp:copyIn", "mtp:delete", "mtp:mkdir", "mtp:rename", "mtp:fetch", "win:corners", "net:discover", "net:open", "locks:who", "locks:kill",
    "shellverbs:set", "pty:available", "pty:spawn", "pty:write", "pty:resize", "pty:kill", "test:capture", "win:startDrag", "win:dragOut", "win:startResize", "test:log", "sys:uptime", "dialogjump:folders", "dialogjump:test", "update:check", "update:status", "update:download", "update:cancel", "update:install",
];

fn dialog_opts(v: &Value) -> DialogOpts {
    DialogOpts {
        title: v["title"].as_str().map(String::from),
        default_path: v["defaultPath"].as_str().map(String::from),
        filters: v["filters"].as_array().map(|a| a.iter().map(|f| (f["name"].as_str().unwrap_or("").to_string(), args::strs(&f["extensions"]))).collect()).unwrap_or_default(),
    }
}
async fn host_blocking<T: Send + 'static>(f: impl FnOnce(&dyn Host) -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(move || f(st().host.as_ref())).await.map_err(|e| e.to_string())
}

pub async fn call(win: &str, name: &str, args: Vec<Value>) -> R {
    let a = Args(args);
    let w = win.to_string();
    // Dogfile Pro calls need the trial or a licence
    if let Some(r) = license::gate(name, &a) {
        return r;
    }
    match name {
        // ---------- Dogfile Pro ----------
        "license:status" => license::status(&a),
        "llm:status" => llm::status(&a),
        "llm:warm" => llm::warm(&a),
        "llm:plan" => llm::plan(&a).await,
        "llm:stop" => llm::stop_call(&a),
        "reminders:list" => reminders::list(&a),
        "reminders:status" => reminders::status(&a),
        "reminders:apply" => reminders::apply_call(&a),
        "reminders:scanNow" => reminders::scan_now(&a),
        "reminders:analyze" => reminders::analyze_call(&a).await,
        "reminders:add" => reminders::add(&a),
        "reminders:update" => reminders::update(&a),
        "reminders:snooze" => reminders::snooze(&a),
        "reminders:remove" => reminders::remove(&a),
        "reminders:test" => reminders::test(&a),
        "license:startTrial" => license::start_trial(&a).await,
        "license:activate" => license::activate(&a).await,
        "license:offlineRequest" => license::offline_request(&a),
        "license:offlineApply" => license::offline_apply(&a),
        "license:deactivate" => license::deactivate(&a).await,
        "license:checkout" => license::checkout(&a).await,
        "license:claim" => license::claim(&a).await,
        "license:refresh" => license::refresh(true).await,
        // ---------- system ----------
        "sys:info" => sys::info(win),
        "sys:findEditor" => sys::find_editor().await,
        "cloud:detect" => sys::cloud_detect().await,
        "theme:get" => Ok(json!({ "dark": st().host.system_dark(), "accent": st().host.accent_color() })),
        "everything:search" => sys::everything_search(&a).await,
        "everything:available" => sys::everything_available().await,
        "everything:status" => sys::everything_status().await,
        "update:check" => update::check(&a).await,
        "update:status" => update::status(&a),
        "update:download" => update::download(win, &a).await,
        "update:cancel" => update::cancel(&a),
        "update:install" => update::install(&a),
        "sys:uptime" => Ok(json!(crate::uptime_ms())),
        "dialogjump:folders" => {
            #[cfg(windows)]
            {
                let list = args::strs(&a.v(0));
                let known: Vec<(String, String)> = a.v(1).as_array().map(|x| x.iter().filter_map(|k| Some((k["label"].as_str()?.to_string(), k["path"].as_str()?.to_string()))).collect()).unwrap_or_default();
                crate::win::dialogjump::set_folders(list, known);
                if crate::setting_bool("dialogJump", true) { crate::win::dialogjump::start(); }
            }
            Ok(json!(true))
        }
        "dialogjump:test" => {
            #[cfg(windows)]
            {
                let (f, n) = (a.s(0)?, a.s(1)?);
                return tokio::task::spawn_blocking(move || crate::win::dialogjump::test(&f, &n)).await.map_err(|e| e.to_string())?.map(|s| json!(s));
            }
            #[allow(unreachable_code)]
            Err("Windows only".into())
        }
        "test:log" => {
            let line = a.s_or(0, "");
            match std::env::var("DOGFILE_TEST_LOG") {
                Ok(f) if st().test_mode => {
                    use std::io::Write;
                    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                        let _ = writeln!(fh, "{line}");
                    }
                }
                _ => println!("[eval] {line}"),
            }
            Ok(json!(true))
        }
        "test:capture" => Ok(json!(st().host.capture(win, &a.s(0)?))),

        // ---------- files ----------
        "fs:list" => fsx::list(&a).await,
        "fs:subdirs" => fsx::subdirs(&a).await,
        "fs:stat" => fsx::stat(&a).await,
        "fs:statMany" => fsx::stat_many(&a).await,
        "fs:exists" => fsx::exists(&a).await,
        "fs:isDir" => fsx::is_dir(&a).await,
        "fs:mkdir" => fsx::mkdir(&a).await,
        "fs:newFile" => fsx::new_file(&a).await,
        "fs:rename" => fsx::rename(&a).await,
        "fs:uniqueName" => fsx::unique_name(&a).await,
        "fs:readText" => fsx::read_text(&a).await,
        "fs:readBytes" => fsx::read_bytes(&a).await,
        "fs:compareBinary" => fsx::compare_binary(&a).await,
        "fs:writeText" => fsx::write_text(&a).await,
        "fs:writeImage" => fsx::write_image(&a).await,
        "fs:hash" => fsx::hash(&a).await,
        "fs:attributes" => fsx::attributes(&a).await,
        "fs:setAttributes" => fsx::set_attributes(&a).await,
        "fs:setTimes" => fsx::set_times(&a).await,
        "fs:symlink" => fsx::symlink(&a).await,
        "fs:shortcut" => fsx::shortcut(&a).await,
        "fs:readLink" => fsx::read_link(&a).await,
        "fs:drives" => sys::drives().await,
        "fs:eject" => shell::eject(&a).await,
        "fs:mapped" => sys::mapped().await,
        "fs:recentWindows" => fsx::recent_windows().await,
        "fs:findUnder" => fsx::find_under(&a).await,
        "fs:trash" => fsx::trash(&a).await,
        "fs:copyFile" => fsx::copy_file(&a).await,
        "fs:writeDataUrl" => fsx::write_data_url(&a).await,
        "fs:readBuffer" => fsx::read_buffer(&a).await,
        "fs:writeEncoded" => fsx::write_encoded(&a).await,
        "fs:watchFile" => watch::watch_file(win, &a),
        "watch:set" => watch::watch_set(win, &a),
        "rules:watch" => watch::rules_watch(win, &a),
        "archive:watchEdit" => watch::archive_watch_edit(win, &a),

        // ---------- shell ----------
        "thumb:get" => shell::thumb(&a).await,
        "icon:get" => shell::icon(&a).await,
        "shell:open" => shell::open(&a).await,
        "shell:openExternal" => shell::open_external(&a).await,
        "shell:openWith" => shell::open_with(&a).await,
        "shell:runAs" => shell::run_as(&a).await,
        "shell:showInExplorer" => shell::show_in_explorer(&a).await,
        "shell:terminal" => shell::terminal(&a).await,
        "shell:properties" => shell::properties(&a).await,
        "shell:verbs" => shell::verbs(&a).await,
        "shell:invokeVerb" => shell::invoke_verb(&a).await,
        "shell:beep" => shell::beep(),
        "shell:launch" => shell::launch(&a).await,
        "shell:runCommand" => shell::run_command(&a).await,
        "shell:wallpaper" => shell::wallpaper(&a).await,
        "recycle:list" => shell::recycle_list().await,
        "recycle:restore" => shell::recycle_restore(&a).await,
        "recycle:restoreOriginal" => shell::recycle_restore_original(&a).await,
        "recycle:deleteForever" => shell::recycle_delete_forever(&a).await,
        "recycle:empty" => shell::recycle_empty().await,
        "locks:who" => shell::who_locks(&a).await,
        "locks:kill" => shell::kill_process(&a).await,
        "net:discover" => shell::net_discover(&a).await,
        "net:open" => shell::net_open(&a).await,
        "mtp:list" | "mtp:copyOut" | "mtp:copyIn" | "mtp:delete" | "mtp:mkdir" | "mtp:rename" => shell::mtp(name, &a).await,
        "mtp:fetch" => shell::mtp_fetch(&a).await,
        "default:get" => shell::default_get().await,
        "default:set" => shell::default_set(&a).await,
        "shellverbs:set" => shell::shellverbs_set(&a).await,

        // ---------- clipboard ----------
        "clip:writeFiles" => {
            clip::write_text(&a.strs(0).join(if util::IS_WIN { "\r\n" } else { "\n" }));
            clip::write_files(&a).await
        }
        "clip:readFiles" => clip::read_files().await,
        "clip:writeText" => Ok(json!(clip::write_text(&a.s_or(0, "")))),
        "clip:readText" => Ok(json!(clip::read_text())),
        "clip:hasImage" => clip::has_image(),
        "clip:formats" => clip::formats(),
        "clip:watch" => clip::watch(win, &a),

        // ---------- operations, archives, jobs, index ----------
        "ops:start" => ops::start_call(&a),
        "ops:control" => ops::control(&a),
        "ops:list" => ops::list(),
        "ops:configure" => ops::configure(&a),
        "ops:resolveConflict" => ops::resolve_conflict(&a),
        "archive:list" => archive::list_call(&a).await,
        "archive:test" => archive::test(&a).await,
        "archive:caps" => archive::caps(),
        "work:start" => engine::work_start(win, &a).await,
        "work:cancel" => engine::work_cancel(&a),
        "index:status" => engine::index_status().await,
        "index:configure" => engine::configure_index(true).await,
        "index:refresh" => engine::index_refresh(&a).await,
        "index:search" => engine::index_search(&a).await,
        "index:sizes" => engine::index_sizes(&a).await,
        "index:fastBuild" => engine::index_fast_build(&a).await,
        "core:info" => engine::core_info().await,

        // ---------- git ----------
        "git:branches" => git::branches(&a).await,
        "git:checkout" => git::checkout(&a).await,
        "git:log" => git::log(&a).await,
        "git:pull" => git::pull(&a).await,
        "git:status" => git::status(&a).await,

        // ---------- servers & network ----------
        "remote:list" => remote::list(&a).await,
        "remote:signIn" => remote::sign_in(&a).await,
        "remote:get" => remote::get(win, &a).await,
        "remote:put" => remote::put(win, &a).await,
        "remote:remove" => remote::remove(&a).await,
        "remote:rename" => remote::rename(&a).await,
        "remote:copy" => remote::copy(&a).await,
        "remote:mkdir" => remote::mkdir(&a).await,
        "remote:open" => remote::open_local(&a).await,
        "remote:test" => remote::test(&a).await,
        "remote:setSecret" => {
            secrets::set_in("connection-secrets", &a.s(0)?, &a.s_or(1, ""));
            Ok(json!(true))
        }
        "remote:disconnect" => {
            remote::close(&a.s(0)?).await;
            Ok(json!(true))
        }
        "net:connectShare" => remote::connect_share(&a).await,
        "net:unc" => Ok(json!(remote::unc_of(&a.v(0)))),
        "net:reachable" => Ok(json!(remote::reachable(&a.s(0)?, a.u(1, 4000)).await)),
        "net:status" => remote::status(&a).await,

        // ---------- features ----------
        "ext:fetch" => ext_fetch(&a).await,
        "docs:featureGuide" => {
            let dir = st().data_dir.join("Features");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let dst = dir.join("Feature guide.md");
            match st().ui.as_ref().and_then(|p| p.get("assets/FEATURES.md")) {
                Some(b) => std::fs::write(&dst, b).map_err(|e| e.to_string())?,
                None => { std::fs::copy(st().renderer_dir.join("assets").join("FEATURES.md"), &dst).map_err(|e| e.to_string())?; }
            }
            Ok(json!(dst.to_string_lossy()))
        }
        "ext:log" => {
            let entry = a.v(0);
            {
                let mut l = ext_logs().lock();
                l.push(entry.clone());
                let n = l.len();
                if n > 500 {
                    l.drain(..n - 500);
                }
            }
            events::broadcast("ext:log", entry);
            Ok(json!(true))
        }
        "ext:logs" => Ok(json!(ext_logs().lock().clone())),
        "ext:clearLogs" => {
            ext_logs().lock().clear();
            events::broadcast("ext:log", json!({ "clear": true }));
            Ok(json!(true))
        }
        "ext:install" => {
            if let Some(m) = st().host.main_windows().into_iter().next() {
                st().host.emit(&m, "ext:install", a.v(0));
                st().host.win_control(&m, "focus");
            }
            Ok(json!(true))
        }
        "secret:set" => Ok(secrets::set(&a.s(0)?, &a.s_or(1, ""))),
        "secret:has" => Ok(secrets::has(&a.s(0)?)),
        "gh:request" => gh_request(&a).await,

        // ---------- documents, media, tags, AI ----------
        "meta:status" => meta::status(&a),
        "m3d:cadStatus" => crate::model3d::cad_status(&a),
        "m3d:cadInstall" => crate::model3d::cad_install(&a),
        "m3d:dwgStatus" => crate::model3d::dwg_status(&a),
        "m3d:dwgToDxf" => crate::model3d::dwg_to_dxf(&a).await,
        "phone:status" => crate::phonelink::status(&a),
        "phone:start" => crate::phonelink::start(&a).await,
        "phone:stop" => crate::phonelink::stop(&a),
        "phone:pair" => crate::phonelink::pair(&a).await,
        "phone:forget" => crate::phonelink::forget(&a),
        "phone:rename" => crate::phonelink::rename(&a),
        "phone:send" => crate::phonelink::send(&a),
        "phone:sendText" => crate::phonelink::send_text(&a),
        "phone:unsend" => crate::phonelink::unsend(&a),
        "meta:install" => meta::install(&a),
        "meta:read" => meta::read(&a).await,
        "meta:write" => meta::write(&a).await,
        "meta:stripGps" => meta::strip_gps(&a).await,
        "meta:stripAll" => meta::strip_all(&a).await,
        "meta:streams" => meta::streams(&a),
        "meta:streamsMany" => meta::streams_many(&a),
        "meta:streamRead" => meta::stream_read(&a),
        "meta:streamWrite" => meta::stream_write(&a),
        "meta:streamRemove" => meta::stream_remove(&a),
        "doc:read" => doc::read_call(&a).await,
        "doc:text" => doc::text_call(&a).await,
        "doc:titles" => doc::titles_call(&a).await,
        "doc:setProps" => doc::set_props_call(&a).await,
        "media:setMeta" => tags::write_media(&a).await,
        "media:probe" => media::probe_call(&a).await,
        "media:imgMeta" => imgmeta::meta(&a).await,
        "media:quickProbe" => media::quick_probe(&a).await,
        "media:sheetCancel" => media::sheet_cancel(&a),
        "media:contactSheet" => media::contact_sheet(win, &a).await,
        "media:encoder" => media::best_encoder_call().await,
        "media:shotDir" => media::screenshot_dir().await,
        "media:export" => media::export(&a).await,
        "media:job" => media::job_status(&a),
        "media:cancel" => media::cancel_job(&a),
        "keywords:read" => crate::keywords::read(&a).await,
        "keywords:write" => crate::keywords::write(&a).await,
        "tags:read" => tags::read(&a).await,
        "tags:write" => tags::write(&a).await,
        "tags:lookup" => tags::lookup(&a).await,
        "tags:identify" => tags::identify(&a).await,
        "tags:fetchArt" => tags::fetch_art(&a).await,
        "ai:status" => ai::status().await,
        "ai:download" => ai::download(&a).await,
        "ai:remove" => ai::remove(&a).await,
        "ai:cacheGet" => ai::cache_get(&a).await,
        "ai:cacheSet" => ai::cache_set(&a).await,

        // ---------- versions, watched, store ----------
        "versions:save" => versions::save_call(&a).await,
        "versions:list" => versions::list(&a).await,
        "versions:restore" => versions::restore(&a).await,
        "versions:remove" => versions::remove(&a).await,
        "versions:overview" => versions::overview().await,
        "versions:track" => versions::track(&a).await,
        "watched:add" => {
            let p = a.s(0)?;
            let mut w = store::get_or("watched", json!({}));
            if !w.is_object() {
                w = json!({});
            }
            w[&p] = json!(util::now_ms());
            let m = w.as_object_mut().unwrap();
            if m.len() > 20000 {
                let mut keys: Vec<(String, f64)> = m.iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect();
                keys.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                for (k, _) in keys.iter().take(m.len() - 20000) {
                    m.remove(k);
                }
            }
            store::set("watched", &w)?;
            Ok(json!(true))
        }
        "watched:get" => Ok(store::get_or("watched", json!({}))),
        "store:get" => Ok(store::get(&a.s(0)?).unwrap_or(Value::Null)),
        "store:set" => store_set(win, &a).await,
        "store:path" => Ok(json!(st().data_dir.to_string_lossy())),

        // ---------- windows ----------
        "win:new" => {
            let mut l = a.v(0);
            if !l.is_object() {
                l = json!({});
            }
            l["fresh"] = json!(true);
            st().host.new_window(l);
            Ok(json!(true))
        }
        "win:control" => {
            let act = a.s_or(0, "");
            Ok(host_blocking(move |h| h.win_control(&w, &act)).await?)
        }
        "win:overlay" => Ok(json!(true)),
        "win:zoom" => {
            st().host.set_zoom(win, a.f(0, 1.0));
            Ok(json!(true))
        }
        "win:corners" => {
            st().host.set_corners(&a.s_or(0, "round"));
            Ok(json!(true))
        }
        "win:startDrag" => {
            st().host.start_window_drag(win);
            Ok(json!(true))
        }
        "win:startResize" => {
            st().host.start_window_resize(win, &a.s_or(0, ""));
            Ok(json!(true))
        }
        "win:dragOut" => {
            st().host.start_drag(win, a.strs(0));
            Ok(json!(true))
        }
        "tool:open" => {
            st().host.open_tool(&a.s(0)?, a.strs(1), a.v(2));
            Ok(json!(true))
        }
        "tool:pending" => Ok(st().host.tool_pending(win)),
        "dialog:pickFolder" => {
            let t = a.os(0);
            Ok(json!(host_blocking(move |h| h.pick_folder(&w, t)).await?))
        }
        "dialog:openFiles" => {
            let o = dialog_opts(a.r(0));
            Ok(json!(host_blocking(move |h| h.open_files(&w, o)).await?))
        }
        "dialog:saveFile" => {
            let o = dialog_opts(a.r(0));
            Ok(json!(host_blocking(move |h| h.save_file(&w, o)).await?))
        }
        "dialog:confirm" => {
            let o = a.v(0);
            let buttons = { let b = args::strs(&o["buttons"]); if b.is_empty() { vec!["OK".to_string(), "Cancel".to_string()] } else { b } };
            let cancel = o["cancelId"].as_u64().map(|x| x as usize).unwrap_or(buttons.len().saturating_sub(1));
            let (title, msg, detail) = (o["title"].as_str().unwrap_or("Dogfile").to_string(), o["message"].as_str().unwrap_or("").to_string(), o["detail"].as_str().unwrap_or("").to_string());
            Ok(json!(host_blocking(move |h| h.message_box(&w, &title, &msg, &detail, buttons, cancel)).await?))
        }

        // ---------- terminal ----------
        "pty:available" => pty::available(),
        "pty:spawn" => pty::spawn(win, &a),
        "pty:write" => pty::write(&a),
        "pty:resize" => pty::resize(&a),
        "pty:kill" => pty::kill(&a),

        _ => Err(format!("Unknown channel {name}")),
    }
}

fn ext_logs() -> &'static parking_lot::Mutex<Vec<Value>> {
    static L: std::sync::OnceLock<parking_lot::Mutex<Vec<Value>>> = std::sync::OnceLock::new();
    L.get_or_init(|| parking_lot::Mutex::new(vec![]))
}

async fn store_set(win: &str, a: &Args) -> R {
    let name = a.s(0)?;
    let v = a.v(1);
    if name == "settings" {
        let old = st().settings.read().clone();
        let idx_changed = old["indexEnabled"] != v["indexEnabled"] || old["indexRoots"] != v["indexRoots"] || old["indexSystem"] != v["indexSystem"];
        *st().settings.write() = v.clone();
        if idx_changed {
            let sys_changed = old["indexSystem"] != v["indexSystem"];
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = engine::configure_index(true).await;
                // which folders are left out changed: build again
                if sys_changed {
                    let _ = engine::request("index.refresh", json!({ "root": "", "mft": setting_bool("indexMft", true) })).await;
                }
            });
        }
        ops::configure_from_settings();
        let dark = match v["theme"].as_str() {
            Some("dark") => Some(true),
            Some("light") => Some(false),
            _ => None,
        };
        st().host.set_theme(dark);
        store::set(&name, &v)?;
        for other in st().host.windows() {
            if other != win {
                st().host.emit(&other, "settings:changed", v.clone());
            }
        }
        return Ok(json!(true));
    }
    store::set(&name, &v)?;
    Ok(json!(true))
}

async fn ext_fetch(a: &Args) -> R {
    let url = a.s(0)?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https addresses".into());
    }
    let o = a.v(1);
    let method = reqwest::Method::from_bytes(o["method"].as_str().unwrap_or("GET").as_bytes()).map_err(|e| e.to_string())?;
    let mut rq = util::http().request(method, &url).timeout(std::time::Duration::from_secs(30));
    if let Some(h) = o["headers"].as_object() {
        for (k, v) in h {
            rq = rq.header(k.as_str(), v.as_str().unwrap_or(""));
        }
    }
    if let Some(b) = o["body"].as_str() {
        rq = rq.body(b.to_string());
    }
    let r = rq.send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let headers: serde_json::Map<String, Value> = r.headers().iter().map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or("")))).collect();
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&b[..b.len().min(5 * 1048576)]).into_owned();
    Ok(json!({ "status": status, "ok": (200..300).contains(&status), "text": text, "headers": headers }))
}

/// GitHub for the feature browser: only api.github.com and raw files; the token never reaches the page
async fn gh_request(a: &Args) -> R {
    let method = a.s_or(0, "GET");
    let p = a.s(1)?;
    let body = a.v(2);
    let auth = a.0.get(3).map(|v| v.as_bool().unwrap_or(true)).unwrap_or(true);
    let ok_host = |u: &str| u.starts_with("https://api.github.com/") || u.starts_with("https://raw.githubusercontent.com/");
    let url = if ok_host(&p) { p } else { format!("https://api.github.com{p}") };
    if !ok_host(&url) {
        return Err("Not a GitHub address".into());
    }
    let mut rq = util::http()
        .request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, &url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(std::time::Duration::from_secs(60));
    if auth && url.starts_with("https://api.github.com") {
        let tok = secrets::get_in("secrets", "github");
        if !tok.is_empty() {
            rq = rq.header("Authorization", format!("Bearer {tok}"));
        }
    }
    if !body.is_null() {
        rq = rq.json(&body);
    }
    let r = rq.send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| e.to_string())?;
    let j: Option<Value> = serde_json::from_str(&text).ok();
    Ok(json!({ "status": status, "ok": (200..300).contains(&status), "text": if j.is_some() { Value::Null } else { json!(text.chars().take(2 * 1048576).collect::<String>()) }, "json": j }))
}
