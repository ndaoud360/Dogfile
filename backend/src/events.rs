// Events from the back end to the windows (same channel names the interface already listens to).
use crate::st;
use serde_json::Value;

pub fn emit(win: &str, channel: &str, data: Value) {
    st().host.emit(win, channel, data);
}
pub fn broadcast(channel: &str, data: Value) {
    st().host.broadcast(channel, data);
}
/// main file-browser windows only
pub fn to_main(channel: &str, data: Value) {
    let h = &st().host;
    for w in h.main_windows() {
        h.emit(&w, channel, data.clone());
    }
}
