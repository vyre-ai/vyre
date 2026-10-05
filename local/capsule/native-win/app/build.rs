// The shell's own commands are permissioned through capabilities/, so a window with no
// capability (the main panel on the remote address) cannot call any of them.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_state", "save_pairing", "set_autostart", "notify", "mount_drive", "unmount_drive", "finish_typed_pair", "identity_public", "identity_sign", "enclave_public", "enclave_sign", "device_key_pub", "device_key_dh", "get_link"]),
        ),
    )
    .expect("tauri build");
}
