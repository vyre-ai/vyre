//! The Windows app shell's native-side logic that can be tested without a real Windows machine
//! or a Tauri app around it (team/0.2/plans/windows.md sections 3-4, superseding
//! docs/design/windows-plan.md section 9's older "Windows Capsule" module shape). As of the 0.2
//! architecture pivot (plans/windows.md, "Architecture pivot" note at the top) this shell holds
//! no local vyred, no named pipe and no server-side tool surface of its own -- it is a thin
//! Tauri wrapper (tray, hotkey, toast, autostart, update) around a WebView2 view of the ordinary
//! web app at the person's own server address. This crate is exactly the part of that shell
//! that's host-independent and worth testing without a real Windows machine or a Tauri
//! toolchain: which hotkey binds by default, and what happens the moment it's held while the
//! panel itself has focus. Host-specific pieces (tray, WebView2 navigation/capability wiring,
//! Windows Hello/WebAuthn, the real `RegisterHotKey` call) live in the actual Tauri app
//! (`src-tauri/`, scaffolded separately, CI-only per docs/work/windows.md -- this Mac has no
//! `cargo` in this session, so nothing here has been locally built or tested, same as when
//! `hotkey.rs` was first written).

pub mod hotkey;

pub mod shell;
pub mod update;
pub mod drive;
pub mod devicekey;
pub mod core_pkg;
