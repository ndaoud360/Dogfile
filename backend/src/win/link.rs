// What a drive is plugged in through and how fast that connection runs, for the transfer panel: "USB 3.2 Gen 1
// (5 Gbps). This drive supports 10 Gbps: the cable, the port or a hub is holding it back."
//
// Windows can't see the cable itself, but it does know what the drive can do and what the connection is actually
// running at; when those differ, something between them (cable, port, hub) is the limit. The route: the folder's
// volume -> its disk -> up the device tree to the USB device -> the hub port it's on -> ask the hub about that port.
// Everything here only reads; any step that fails just means "unknown" and the transfer carries on as normal.
#![allow(non_snake_case, clippy::upper_case_acronyms)]
use serde_json::{json, Value};
use std::ffi::c_void;

type HANDLE = isize;
const INVALID: HANDLE = -1;

#[repr(C)]
#[derive(Clone, Copy)]
struct Guid {
    d1: u32,
    d2: u16,
    d3: u16,
    d4: [u8; 8],
}
const fn guid(v: u128) -> Guid {
    Guid { d1: (v >> 96) as u32, d2: (v >> 80) as u16, d3: (v >> 64) as u16, d4: ((v as u64) & u64::MAX).to_be_bytes() }
}
#[repr(C)]
struct DevPropKey {
    fmtid: Guid,
    pid: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *const c_void, disposition: u32, flags: u32, template: HANDLE) -> HANDLE;
    fn DeviceIoControl(h: HANDLE, code: u32, inbuf: *const c_void, inlen: u32, outbuf: *mut c_void, outlen: u32, returned: *mut u32, overlapped: *mut c_void) -> i32;
    fn CloseHandle(h: HANDLE) -> i32;
    fn GetVolumePathNameW(path: *const u16, out: *mut u16, len: u32) -> i32;
    fn GetVolumeNameForVolumeMountPointW(mount: *const u16, out: *mut u16, len: u32) -> i32;
}
#[link(name = "cfgmgr32")]
unsafe extern "system" {
    fn CM_Get_Device_Interface_List_SizeW(len: *mut u32, guid: *const Guid, devid: *const u16, flags: u32) -> u32;
    fn CM_Get_Device_Interface_ListW(guid: *const Guid, devid: *const u16, buf: *mut u16, len: u32, flags: u32) -> u32;
    fn CM_Get_Device_Interface_PropertyW(iface: *const u16, key: *const DevPropKey, ty: *mut u32, buf: *mut u8, size: *mut u32, flags: u32) -> u32;
    fn CM_Locate_DevNodeW(dn: *mut u32, id: *const u16, flags: u32) -> u32;
    fn CM_Get_Parent(out: *mut u32, dn: u32, flags: u32) -> u32;
    fn CM_Get_Device_IDW(dn: u32, buf: *mut u16, len: u32, flags: u32) -> u32;
    fn CM_Get_DevNode_PropertyW(dn: u32, key: *const DevPropKey, ty: *mut u32, buf: *mut u8, size: *mut u32, flags: u32) -> u32;
}

const GUID_DEVINTERFACE_DISK: Guid = guid(0x53f56307_b6bf_11d0_94f2_00a0c91efb8b);
const GUID_DEVINTERFACE_USB_HUB: Guid = guid(0xf18a0e88_c30c_11d0_8815_00a0c906bed8);
const DEVPKEY_DEVICE_INSTANCE_ID: DevPropKey = DevPropKey { fmtid: guid(0x78c34fc8_104a_4aca_9ea4_524d52996e57), pid: 256 };
const DEVPKEY_DEVICE_ADDRESS: DevPropKey = DevPropKey { fmtid: guid(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 30 };

const IOCTL_STORAGE_GET_DEVICE_NUMBER: u32 = 0x002D_1080;
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
const IOCTL_STORAGE_GET_HOTPLUG_INFO: u32 = 0x002D_0C14;
const IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX: u32 = 0x0022_0448;
const IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2: u32 = 0x0022_045C;
/// Windows 10 1803 and later: lane count and lane speed of a SuperSpeedPlus connection
const IOCTL_USB_GET_NODE_CONNECTION_SUPERSPEEDPLUS_INFORMATION: u32 = 0x0022_0478;

const GENERIC_WRITE: u32 = 0x4000_0000;
const SHARE_RW: u32 = 0x1 | 0x2;
const OPEN_EXISTING: u32 = 3;

struct H(HANDLE);
impl Drop for H {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
fn from_wide(b: &[u16]) -> String {
    String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
}
fn open(path: &str, access: u32) -> Option<H> {
    let w = wide(path);
    let h = unsafe { CreateFileW(w.as_ptr(), access, SHARE_RW, std::ptr::null(), OPEN_EXISTING, 0, 0) };
    if h == INVALID || h == 0 { None } else { Some(H(h)) }
}
fn ioctl(h: &H, code: u32, inbuf: &[u8], out: &mut [u8]) -> Option<usize> {
    let mut got = 0u32;
    let ok = unsafe { DeviceIoControl(h.0, code, inbuf.as_ptr() as *const c_void, inbuf.len() as u32, out.as_mut_ptr() as *mut c_void, out.len() as u32, &mut got, std::ptr::null_mut()) };
    if ok != 0 { Some(got as usize) } else { None }
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    b.get(i..i + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0)
}

/// "\\?\Volume{…}" for a folder (works for drive letters and drives mounted in a folder)
fn volume_of(path: &str) -> Option<String> {
    if path.starts_with("\\\\") && !path.starts_with("\\\\?\\") {
        return None; // network share: there's no local link to look at
    }
    let w = wide(path);
    let mut root = vec![0u16; 1024];
    if unsafe { GetVolumePathNameW(w.as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0 {
        return None;
    }
    let mut vol = vec![0u16; 128];
    if unsafe { GetVolumeNameForVolumeMountPointW(root.as_ptr(), vol.as_mut_ptr(), vol.len() as u32) } == 0 {
        return None;
    }
    Some(from_wide(&vol).trim_end_matches('\\').to_string())
}
fn disk_number(h: &H) -> Option<u32> {
    let mut out = [0u8; 12];
    ioctl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, &[], &mut out)?;
    // FILE_DEVICE_DISK
    if u32_at(&out, 0) != 7 { return None }
    Some(u32_at(&out, 4))
}
/// STORAGE_PROPERTY_QUERY { PropertyId, PropertyStandardQuery, AdditionalParameters[1] }
fn query(h: &H, property: u32) -> Option<Vec<u8>> {
    let mut q = [0u8; 12];
    q[..4].copy_from_slice(&property.to_le_bytes());
    let mut out = vec![0u8; 1024];
    let n = ioctl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, &mut out)?;
    out.truncate(n);
    Some(out)
}
fn ascii_at(b: &[u8], off: u32) -> String {
    let off = off as usize;
    if off == 0 || off >= b.len() { return String::new() }
    let end = b[off..].iter().position(|&c| c == 0).map(|p| off + p).unwrap_or(b.len());
    String::from_utf8_lossy(&b[off..end]).trim().to_string()
}

fn interfaces(class: &Guid, device_id: Option<&str>) -> Vec<String> {
    let id = device_id.map(wide);
    let idp = id.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null());
    let mut len = 0u32;
    if unsafe { CM_Get_Device_Interface_List_SizeW(&mut len, class, idp, 0) } != 0 || len < 2 {
        return vec![];
    }
    let mut buf = vec![0u16; len as usize];
    if unsafe { CM_Get_Device_Interface_ListW(class, idp, buf.as_mut_ptr(), len, 0) } != 0 {
        return vec![];
    }
    buf.split(|&c| c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
}
fn device_id(dn: u32) -> String {
    let mut buf = vec![0u16; 512];
    if unsafe { CM_Get_Device_IDW(dn, buf.as_mut_ptr(), buf.len() as u32, 0) } != 0 { return String::new() }
    from_wide(&buf)
}
fn parent(dn: u32) -> Option<u32> {
    let mut p = 0u32;
    if unsafe { CM_Get_Parent(&mut p, dn, 0) } == 0 { Some(p) } else { None }
}
fn usb_port(dn: u32) -> Option<u32> {
    let (mut ty, mut v, mut size) = (0u32, 0u32, 4u32);
    let r = unsafe { CM_Get_DevNode_PropertyW(dn, &DEVPKEY_DEVICE_ADDRESS, &mut ty, &mut v as *mut u32 as *mut u8, &mut size, 0) };
    if r == 0 && v > 0 { Some(v) } else { None }
}
/// the device node of the disk with this number
fn disk_node(number: u32) -> Option<u32> {
    for iface in interfaces(&GUID_DEVINTERFACE_DISK, None) {
        let Some(h) = open(&iface, 0) else { continue };
        if disk_number(&h) != Some(number) { continue }
        let w = wide(&iface);
        let mut buf = vec![0u8; 1024];
        let (mut ty, mut size) = (0u32, buf.len() as u32);
        if unsafe { CM_Get_Device_Interface_PropertyW(w.as_ptr(), &DEVPKEY_DEVICE_INSTANCE_ID, &mut ty, buf.as_mut_ptr(), &mut size, 0) } != 0 { return None }
        let id: Vec<u16> = buf[..size as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let mut dn = 0u32;
        if unsafe { CM_Locate_DevNodeW(&mut dn, id.as_ptr(), 0) } != 0 { return None }
        return Some(dn);
    }
    None
}

/// a speed in a few words, and in megabits per second
fn usb_name(mbps: u32) -> &'static str {
    match mbps {
        m if m >= 40000 => "USB4 (40 Gbps)",
        m if m >= 20000 => "USB 3.2 Gen 2x2 (20 Gbps)",
        m if m >= 10000 => "USB 3.2 Gen 2 (10 Gbps)",
        m if m >= 5000 => "USB 3.2 Gen 1 (5 Gbps)",
        m if m >= 480 => "USB 2.0 (480 Mbps)",
        m if m >= 12 => "USB 1.1 (12 Mbps)",
        _ => "USB 1.0 (1.5 Mbps)",
    }
}
/// roughly the most a drive moves over a link of this speed, in bytes per second (after protocol overhead)
fn usable_bytes(mbps: u32) -> u64 {
    let mb = match mbps {
        m if m >= 40000 => 3800,
        m if m >= 20000 => 2000,
        m if m >= 10000 => 1050,
        m if m >= 5000 => 450,
        m if m >= 480 => 42,
        _ => 1,
    };
    mb * 1_000_000
}

/// the USB connection of the device at `port` on the hub `hub_dn`: (running at, capable of), in Mbps
fn usb_speeds(hub_dn: u32, port: u32) -> Option<(u32, u32)> {
    let hub_id = device_id(hub_dn);
    let iface = interfaces(&GUID_DEVINTERFACE_USB_HUB, Some(&hub_id)).into_iter().next()?;
    let hub = open(&iface, GENERIC_WRITE)?;
    // USB_NODE_CONNECTION_INFORMATION_EX_V2: { ConnectionIndex, Length, SupportedUsbProtocols (in: what we understand), Flags }
    let mut v2 = [0u8; 16];
    v2[..4].copy_from_slice(&port.to_le_bytes());
    v2[4..8].copy_from_slice(&16u32.to_le_bytes());
    v2[8..12].copy_from_slice(&0b111u32.to_le_bytes());
    let mut out = [0u8; 16];
    let have_v2 = ioctl(&hub, IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2, &v2, &mut out).is_some();
    let protocols = if have_v2 { u32_at(&out, 8) } else { 0 };
    let flags = if have_v2 { u32_at(&out, 12) } else { 0 };
    let (ss_now, ss_can, ssp_now, ssp_can) = (flags & 1 != 0, flags & 2 != 0, flags & 4 != 0, flags & 8 != 0);
    // USB_NODE_CONNECTION_INFORMATION_EX (packed): ConnectionIndex(4) DeviceDescriptor(18) CurrentConfigurationValue(1) Speed(1)
    let mut ex = vec![0u8; 512];
    ex[..4].copy_from_slice(&port.to_le_bytes());
    let mut ex_out = vec![0u8; 512];
    let legacy = ioctl(&hub, IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX, &ex, &mut ex_out).map(|_| ex_out[23]);
    // SuperSpeedPlus: the real lane speed and lane count (10 or 20 Gbps), when Windows can tell
    let ssp_mbps = || -> Option<u32> {
        let mut q = [0u8; 24];
        q[..4].copy_from_slice(&port.to_le_bytes());
        q[4..8].copy_from_slice(&24u32.to_le_bytes());
        let mut o = [0u8; 24];
        ioctl(&hub, IOCTL_USB_GET_NODE_CONNECTION_SUPERSPEEDPLUS_INFORMATION, &q, &mut o)?;
        let speed = u32_at(&o, 8);
        let lanes = u32_at(&o, 12).clamp(1, 2);
        let exponent = (speed >> 4) & 0b11;
        let mantissa = speed >> 16;
        let lane_mbps = match exponent { 3 => mantissa * 1000, 2 => mantissa, _ => 0 };
        let total = lane_mbps * lanes;
        if (10000..=40000).contains(&total) { Some(total) } else { None }
    };
    let now = if ssp_now {
        ssp_mbps().unwrap_or(10000)
    } else if ss_now || legacy == Some(3) {
        5000
    } else {
        match legacy { Some(2) => 480, Some(1) => 12, Some(0) => 2, _ => return None }
    };
    let can = if ssp_can {
        now.max(10000)
    } else if ss_can || protocols & 0b100 != 0 {
        5000
    } else if protocols & 0b010 != 0 || now >= 480 {
        now.max(480)
    } else {
        now
    };
    Some((now, can.max(now)))
}

/// What the drive holding `path` is connected through. None for network folders, or when Windows won't say.
pub fn drive_link(path: &str) -> Option<Value> {
    let vol = volume_of(path)?;
    let h = open(&vol, 0)?;
    let number = disk_number(&h)?;
    let desc = query(&h, 0).unwrap_or_default(); // StorageDeviceProperty
    let bus = u32_at(&desc, 28);
    let name = [ascii_at(&desc, u32_at(&desc, 12)), ascii_at(&desc, u32_at(&desc, 16))].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let seek_penalty = query(&h, 7).map(|b| b.get(8).copied().unwrap_or(0) != 0).unwrap_or(false); // StorageDeviceSeekPenaltyProperty
    let mut hot = [0u8; 8];
    hot[..4].copy_from_slice(&8u32.to_le_bytes());
    let hotplug = ioctl(&h, IOCTL_STORAGE_GET_HOTPLUG_INFO, &[], &mut hot).map(|_| hot[6] != 0 || hot[4] != 0).unwrap_or(false);
    drop(h);
    let base = json!({ "drive": name, "rotating": seek_penalty, "external": hotplug || bus == 7 });
    // NVMe that can be unplugged: a Thunderbolt or USB4 enclosure. Windows doesn't report that link's speed.
    if bus == 17 {
        if !hotplug { return Some(merge(base, json!({ "bus": "NVMe" }))) }
        return Some(merge(base, json!({ "bus": "Thunderbolt or USB4", "note": "Windows doesn’t report the link speed for Thunderbolt and USB4 drives." })));
    }
    if bus != 7 {
        let label = match bus { 11 => "SATA", 12 => "SD card", 13 => "Memory card", 8 => "RAID", 10 => "SAS", 17 => "NVMe", _ => "" };
        return if label.is_empty() { None } else { Some(merge(base, json!({ "bus": label }))) };
    }
    // a USB drive: from the disk up to the USB device itself (skipping UAS/USBSTOR layers and composite interfaces)
    let mut dn = disk_node(number)?;
    let mut usb = None;
    for _ in 0..12 {
        dn = parent(dn)?;
        let id = device_id(dn).to_ascii_uppercase();
        if id.starts_with("USB\\") && !id.contains("ROOT_HUB") && !id.contains("&MI_") {
            usb = Some(dn);
            break;
        }
    }
    let usb = usb?;
    let port = usb_port(usb)?;
    let hub = parent(usb)?;
    let (now, can) = usb_speeds(hub, port)?;
    Some(merge(base, json!({
        "bus": "USB", "now": usb_name(now), "nowMbps": now, "can": usb_name(can), "canMbps": can,
        "limited": can > now, "maxBytes": usable_bytes(now),
    })))
}
fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(x), Some(y)) = (a.as_object_mut(), b.as_object()) {
        for (k, v) in y { x.insert(k.clone(), v.clone()); }
    }
    a
}

#[cfg(test)]
mod tests {
    // runs on the Windows test machine: the system drive must be described (or politely unknown), never crash
    #[test]
    fn system_drive_link_is_safe() {
        let r = super::drive_link("C:\\Windows");
        println!("C: link = {r:?}");
        assert!(super::drive_link("\\\\server\\share\\x").is_none());
    }
}
