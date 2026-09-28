//! The Windows Capsule shell's native-side logic that can be tested without a real Windows
//! machine or a Tauri app around it (docs/design/windows-plan.md section 9). Host-specific
//! pieces (tray, WebView2, Windows Hello, RegisterHotKey itself) are not here yet; this module
//! is the part that needs to be *right* before any of that goes up: which hotkey binds by
//! default, and what happens the moment it's held while the panel itself has focus.

pub mod hotkey;
