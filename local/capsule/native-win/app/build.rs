// The shell's own commands are permissioned through capabilities/, so a window with no
// capability (the main panel on the remote address) cannot call any of them.
fn main() {
    // The release always carries the app's web build (app-web/index.html, put there by capsule-win.yml); a Windows app without it has no first run. VYRE_ALLOW_NO_WEB=1 is for a hand-run check of other code only.
    println!("cargo:rerun-if-changed=app-web");
    if std::env::var("VYRE_ALLOW_NO_WEB").as_deref() != Ok("1") && !std::path::Path::new("app-web/index.html").is_file() {
        panic!("app-web/index.html is missing: build the app's web export (apps/app, expo export -p web) into local/capsule/native-win/app/app-web first");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_state", "save_pairing", "set_autostart", "notify", "mount_drive", "unmount_drive", "finish_typed_pair", "identity_public", "identity_sign", "identity_has", "setup_finished", "identity_forget", "enclave_public", "enclave_sign", "agree_public", "agree_secret", "device_key_pub", "device_key_dh", "get_link"]),
        ),
    )
    .expect("tauri build");
}
