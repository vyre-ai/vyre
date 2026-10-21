//! The window's place and size, remembered so the next open is the same.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

pub const DEFAULT_W: f64 = 1180.0;
pub const DEFAULT_H: f64 = 780.0;
pub const MIN_W: f64 = 380.0;
pub const MIN_H: f64 = 560.0;

pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub placed: bool,
}

pub fn load(app: &AppHandle) -> Frame {
    let fallback = Frame { x: 0.0, y: 0.0, w: DEFAULT_W, h: DEFAULT_H, placed: false };
    let Some(path) = path_of(app) else { return fallback };
    let Ok(text) = std::fs::read_to_string(path) else { return fallback };
    parse(&text).unwrap_or(fallback)
}

/// A saved frame, or none when the text is not one. Sizes under the least, or not finite, are refused.
pub fn parse(text: &str) -> Option<Frame> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let n = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|n| n.is_finite());
    let w = n("w")?;
    let h = n("h")?;
    let x = n("x")?;
    let y = n("y")?;
    if w < MIN_W || h < MIN_H || w > 16000.0 || h > 16000.0 { return None; }
    Some(Frame { x, y, w, h, placed: true })
}

pub fn apply(win: &WebviewWindow, frame: &Frame) {
    let _ = win.set_size(LogicalSize::new(frame.w, frame.h));
    if frame.placed {
        let _ = win.set_position(LogicalPosition::new(frame.x, frame.y));
    }
}

pub fn save(app: &AppHandle, win: &WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 { return; }
    let Ok(size) = win.inner_size() else { return };
    let Ok(pos) = win.outer_position() else { return };
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    if w < MIN_W || h < MIN_H { return; }
    let x = pos.x as f64 / scale;
    let y = pos.y as f64 / scale;
    let Some(path) = path_of(app) else { return };
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let body = format!("{{\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}\n");
    let _ = std::fs::write(path, body);
}

fn path_of(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("window.json"))
}
