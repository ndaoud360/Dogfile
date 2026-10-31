// Registry: Dogfile as the default file manager (folders and Win+E), and "Edit with Dogfile Notepad",
// "Play with Dogfile Player", "View with Dogfile Photos" in Explorer's right-click menu. Current user only.
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

// Folders and drives on disk, This PC, the Recycle Bin and Win+E open in Dogfile. Control Panel, Settings pages,
// printers and other Windows-only places keep opening in File Explorer (registering for every "Folder" sent them
// to Dogfile too, which can't show them).
const KEYS: [&str; 5] = [
    r"Software\Classes\Directory\shell\open\command",
    r"Software\Classes\Drive\shell\open\command",
    r"Software\Classes\CLSID\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\shell\open\command",
    r"Software\Classes\CLSID\{645FF040-5081-101B-9F08-00AA002F954E}\shell\open\command",
    r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command",
];
// earlier versions registered for every folder
const OLD: [&str; 2] = [r"Software\Classes\Folder\shell\open", r"Software\Classes\Folder\shell\explore"];
fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}
fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}
fn ours(key: &str) -> bool {
    let name = std::path::Path::new(&exe()).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let v: String = hkcu().open_subkey(key).and_then(|k| k.get_value("")).unwrap_or_default();
    !name.is_empty() && v.to_lowercase().contains(&name)
}
pub fn is_default() -> bool {
    ours(KEYS[0]) || ours(&format!("{}\\command", OLD[0]))
}
/// at start: a default set by an earlier version moves to the new keys (so Control Panel opens again)
pub fn migrate() {
    if ours(&format!("{}\\command", OLD[0])) {
        set_default(true);
    }
}
pub fn set_default(on: bool) {
    let exe = exe();
    for k in OLD {
        let _ = hkcu().delete_subkey_all(k);
    }
    if on {
        for key in KEYS {
            if let Ok((k, _)) = hkcu().create_subkey(key) {
                let cmd = if key.contains("opennewwindow") { format!("\"{exe}\"") } else { format!("\"{exe}\" \"%1\"") };
                let _ = k.set_value("", &cmd);
                let _ = k.set_value("DelegateExecute", &"");
            }
        }
    } else {
        for key in KEYS {
            // the verb key (…\shell\open), not only its command
            let verb = key.trim_end_matches("\\command");
            let _ = hkcu().delete_subkey_all(verb);
        }
    }
}
pub fn set_shell_verbs(on: bool) {
    let exe = exe();
    let edit = r"Software\Classes\*\shell\DogfileEdit";
    let play = r"Software\Classes\SystemFileAssociations\video\shell\DogfilePlay";
    let play_a = r"Software\Classes\SystemFileAssociations\audio\shell\DogfilePlay";
    let view = r"Software\Classes\SystemFileAssociations\image\shell\DogfileView";
    // the old Atlas Files entries go either way
    for k in [r"Software\Classes\*\shell\AtlasEdit", r"Software\Classes\SystemFileAssociations\video\shell\AtlasPlay", r"Software\Classes\SystemFileAssociations\audio\shell\AtlasPlay", r"Software\Classes\SystemFileAssociations\image\shell\AtlasView"] {
        let _ = hkcu().delete_subkey_all(k);
    }
    let add = |key: &str, label: &str, flag: &str| {
        if let Ok((k, _)) = hkcu().create_subkey(key) {
            let _ = k.set_value("", &label);
            let _ = k.set_value("Icon", &format!("\"{exe}\",0"));
        }
        if let Ok((k, _)) = hkcu().create_subkey(format!(r"{key}\command")) {
            let _ = k.set_value("", &format!("\"{exe}\" {flag} \"%1\""));
        }
    };
    if on {
        add(edit, "Edit with Dogfile Notepad", "--edit");
        add(play, "Play with Dogfile Player", "--play");
        add(play_a, "Play with Dogfile Player", "--play");
        add(view, "View with Dogfile Photos", "--view");
    } else {
        for k in [edit, play, play_a, view] {
            let _ = hkcu().delete_subkey_all(k);
        }
    }
}
