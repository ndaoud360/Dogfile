// Registry: Dogfile as the default file manager (folders and Win+E), and "Edit with Dogfile Notepad",
// "Play with Dogfile Player", "View with Dogfile Photos" in Explorer's right-click menu. Current user only.
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const KEYS: [&str; 3] = [
    r"Software\Classes\Folder\shell\open\command",
    r"Software\Classes\Folder\shell\explore\command",
    r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command",
];
fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}
fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}
pub fn is_default() -> bool {
    let Ok(k) = hkcu().open_subkey(KEYS[0]) else { return false };
    let v: String = k.get_value("").unwrap_or_default();
    let name = std::path::Path::new(&exe()).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    !name.is_empty() && v.to_lowercase().contains(&name)
}
pub fn set_default(on: bool) {
    let exe = exe();
    if on {
        for key in KEYS {
            if let Ok((k, _)) = hkcu().create_subkey(key) {
                let cmd = if key.contains("opennewwindow") { format!("\"{exe}\"") } else { format!("\"{exe}\" \"%1\"") };
                let _ = k.set_value("", &cmd);
                let _ = k.set_value("DelegateExecute", &"");
            }
        }
    } else {
        let _ = hkcu().delete_subkey_all(r"Software\Classes\Folder\shell\open");
        let _ = hkcu().delete_subkey_all(r"Software\Classes\Folder\shell\explore");
        let _ = hkcu().delete_subkey_all(r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}");
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
