// What the back end needs from whoever shows the windows (the Tauri app, or the development server).
use serde_json::Value;

pub struct DialogOpts {
    pub title: Option<String>,
    pub default_path: Option<String>,
    /// (name, extensions)
    pub filters: Vec<(String, Vec<String>)>,
}

pub trait Host: Send + Sync + 'static {
    /// Send an event to one window (its main page, like Electron's webContents.send).
    fn emit(&self, win: &str, channel: &str, data: Value);
    /// Send an event to every window.
    fn broadcast(&self, channel: &str, data: Value);
    /// Labels of the open windows, focused first.
    fn windows(&self) -> Vec<String>;
    /// main file-browser windows only (not Notepad / Player / Photos windows)
    fn main_windows(&self) -> Vec<String> {
        self.windows().into_iter().filter(|w| w.starts_with("main")).collect()
    }
    fn focused(&self) -> Option<String> {
        self.windows().into_iter().next()
    }
    /// minimize / max / close / fullscreen / ontop / focus / quit / devtools / isFullscreen
    fn win_control(&self, win: &str, action: &str) -> Value;
    /// a new file-browser window
    fn new_window(&self, launch: Value);
    /// open a folder (and select a file) in the window already open, or a new one
    fn open_path(&self, launch: Value) {
        self.new_window(launch)
    }
    /// Dogfile Notepad / Player / Photos in their own window
    fn open_tool(&self, kind: &str, files: Vec<String>, opts: Value);
    /// what a tool window was opened with (asked once by the page)
    fn tool_pending(&self, win: &str) -> Value;
    /// what a main window was launched with (path / select / fresh)
    fn launch_of(&self, win: &str) -> Value;
    fn set_zoom(&self, win: &str, factor: f64);
    /// drag files out of the window (to Explorer, the desktop, mail…)
    fn start_drag(&self, win: &str, paths: Vec<String>);
    /// move the window with the mouse (from a title-bar area)
    fn start_window_drag(&self, win: &str);
    /// resize the window with the mouse from an edge (North, SouthEast…)
    fn start_window_resize(&self, _win: &str, _dir: &str) {}
    /// Windows 11 corner style for all windows: square / round / small
    fn set_corners(&self, pref: &str);
    /// title bar colours changed (the app draws its own buttons; nothing to do by default)
    fn set_theme(&self, _dark: Option<bool>) {}
    fn ensure_tray(&self) {}
    fn pick_folder(&self, win: &str, title: Option<String>) -> Option<String>;
    fn open_files(&self, win: &str, o: DialogOpts) -> Vec<String>;
    fn save_file(&self, win: &str, o: DialogOpts) -> Option<String>;
    /// a message box: index of the chosen button
    fn message_box(&self, win: &str, title: &str, message: &str, detail: &str, buttons: Vec<String>, cancel_id: usize) -> usize;
    /// whether the system is in dark mode
    fn system_dark(&self) -> bool {
        false
    }
    fn accent_color(&self) -> Option<String> {
        None
    }
    fn native_window_handle(&self, _win: &str) -> Option<isize> {
        None
    }
    /// save a screenshot of the window (test runs)
    fn capture(&self, _win: &str, _file: &str) -> bool {
        false
    }
    fn quit(&self);
}
