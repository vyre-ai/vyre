//! This computer's TPM key for the device entry's `enclave` field (NK-2): a P-256 key made in the Trusted Platform Module through CNG's "Microsoft Platform Crypto Provider", with a UI policy
//! asking Windows to ask the person for a signature. THAT A PROMPT FOLLOWS EVERY SIGNATURE IS NOT PROVEN: it needs a run on a TPM computer (reviewer-3, 5 Oct), and the Platform Crypto Provider's
//! consent prompt may not be Windows Hello's (Hello's per-use consent is the Passport provider's, KeyCredentialManager). Until it is shown, the page treats this key as no proof of the person: the
//! device entry is held as a web key and cannot change who speaks for the identity (src/identity/mac-key.ts `shellKeyHeld`). The private key never leaves the TPM. The signature is the raw 64 bytes r||s CNG gives for ECDSA, over the
//! SHA-256 of the message; the public key is the raw uncompressed point (65 bytes). A computer with no TPM, or no Windows Hello set up, has no such key: every call says so, and its device entry
//! signs with its Ed25519 key alone, as a Mac with no Secure Enclave does.
//!
//! The CNG calls are declared here directly (ncrypt.dll) so they do not depend on a windows-sys version's types. Everything is Windows only; other hosts get the same functions refusing.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    type Status = i32;
    type Handle = usize;

    #[repr(C)]
    struct UiPolicy { dw_version: u32, dw_flags: u32, psz_creation_title: *const u16, psz_friendly_name: *const u16, psz_description: *const u16 }

    #[link(name = "ncrypt")]
    extern "system" {
        fn NCryptOpenStorageProvider(ph_provider: *mut Handle, psz_provider_name: *const u16, dw_flags: u32) -> Status;
        fn NCryptOpenKey(h_provider: Handle, ph_key: *mut Handle, psz_key_name: *const u16, dw_legacy_key_spec: u32, dw_flags: u32) -> Status;
        fn NCryptCreatePersistedKey(h_provider: Handle, ph_key: *mut Handle, psz_alg_id: *const u16, psz_key_name: *const u16, dw_legacy_key_spec: u32, dw_flags: u32) -> Status;
        fn NCryptSetProperty(h_object: Handle, psz_property: *const u16, pb_input: *const u8, cb_input: u32, dw_flags: u32) -> Status;
        fn NCryptFinalizeKey(h_key: Handle, dw_flags: u32) -> Status;
        fn NCryptExportKey(h_key: Handle, h_export_key: Handle, psz_blob_type: *const u16, p_parameter_list: *const c_void, pb_output: *mut u8, cb_output: u32, pcb_result: *mut u32, dw_flags: u32) -> Status;
        fn NCryptSignHash(h_key: Handle, p_padding_info: *const c_void, pb_hash_value: *const u8, cb_hash_value: u32, pb_signature: *mut u8, cb_signature: u32, pcb_result: *mut u32, dw_flags: u32) -> Status;
        fn NCryptFreeObject(h_object: Handle) -> Status;
        fn NCryptImportKey(h_provider: Handle, h_import_key: Handle, psz_blob_type: *const u16, p_parameter_list: *const c_void, ph_key: *mut Handle, pb_data: *const u8, cb_data: u32, dw_flags: u32) -> Status;
        fn NCryptSecretAgreement(h_priv_key: Handle, h_pub_key: Handle, ph_agreed_secret: *mut Handle, dw_flags: u32) -> Status;
        fn NCryptDeriveKey(h_shared_secret: Handle, pwsz_kdf: *const u16, p_parameter_list: *const c_void, pb_derived_key: *mut u8, cb_derived_key: u32, pcb_result: *mut u32, dw_flags: u32) -> Status;
    }

    fn w(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    const NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG: u32 = 0x2;
    const KEY_NAME: &str = "Vyre identity enclave key";

    struct Prov(Handle);
    impl Drop for Prov { fn drop(&mut self) { if self.0 != 0 { unsafe { NCryptFreeObject(self.0) }; } } }
    struct Key(Handle);
    impl Drop for Key { fn drop(&mut self) { if self.0 != 0 { unsafe { NCryptFreeObject(self.0) }; } } }

    fn provider() -> Result<Prov, String> {
        let mut h: Handle = 0;
        let name = w("Microsoft Platform Crypto Provider");
        let s = unsafe { NCryptOpenStorageProvider(&mut h, name.as_ptr(), 0) };
        if s != 0 { return Err("This computer has no TPM that Vyre can use.".into()); }
        Ok(Prov(h))
    }

    fn open(p: &Prov) -> Option<Key> {
        let mut h: Handle = 0;
        let name = w(KEY_NAME);
        let s = unsafe { NCryptOpenKey(p.0, &mut h, name.as_ptr(), 0, 0) };
        if s == 0 { Some(Key(h)) } else { None }
    }

    fn make(p: &Prov) -> Result<Key, String> {
        let mut h: Handle = 0;
        let alg = w("ECDSA_P256");
        let name = w(KEY_NAME);
        if unsafe { NCryptCreatePersistedKey(p.0, &mut h, alg.as_ptr(), name.as_ptr(), 0, 0) } != 0 { return Err("This computer's TPM would not make a key.".into()); }
        let key = Key(h);
        // Windows asks the person (Windows Hello) every time this key signs.
        let title = w("Vyre");
        let friendly = w("Vyre identity key");
        let desc = w("Approve this change to your name");
        let ui = UiPolicy { dw_version: 1, dw_flags: NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG, psz_creation_title: title.as_ptr(), psz_friendly_name: friendly.as_ptr(), psz_description: desc.as_ptr() };
        let prop = w("UI Policy");
        let st = unsafe { NCryptSetProperty(key.0, prop.as_ptr(), &ui as *const UiPolicy as *const u8, std::mem::size_of::<UiPolicy>() as u32, 0) };
        if st != 0 { return Err("Windows Hello is not set up on this computer.".into()); }
        if unsafe { NCryptFinalizeKey(key.0, 0) } != 0 { return Err("This computer's TPM would not keep the key.".into()); }
        Ok(key)
    }

    /// The key's public point (65 bytes), made on first use when `create`. Err with plain words when there is no TPM, no Windows Hello, or no key and `create` is false.
    pub fn public_point(create: bool) -> Result<[u8; 65], String> {
        let p = provider()?;
        let key = match open(&p) { Some(k) => k, None if create => make(&p)?, None => return Err("There is no TPM key on this computer.".into()) };
        let blob_type = w("ECCPUBLICBLOB");
        let mut need: u32 = 0;
        if unsafe { NCryptExportKey(key.0, 0, blob_type.as_ptr(), null(), null_mut(), 0, &mut need, 0) } != 0 { return Err("The TPM key could not be read.".into()); }
        let mut blob = vec![0u8; need as usize];
        let mut got: u32 = 0;
        if unsafe { NCryptExportKey(key.0, 0, blob_type.as_ptr(), null(), blob.as_mut_ptr(), need, &mut got, 0) } != 0 { return Err("The TPM key could not be read.".into()); }
        blob.truncate(got as usize);
        vyre_capsule_win::identity::point_from_ecc_blob(&blob).ok_or_else(|| "The TPM key is not a P-256 key.".to_string())
    }

    /// The raw 64-byte signature (r then s) over the SHA-256 of `message`; Windows asks the person first. Err when there is no key or the person says no.
    pub fn sign(message: &[u8]) -> Result<[u8; 64], String> {
        use sha2::{Digest, Sha256};
        let p = provider()?;
        let key = open(&p).ok_or_else(|| "There is no TPM key on this computer.".to_string())?;
        let digest = Sha256::digest(message);
        let mut sig = [0u8; 64];
        let mut got: u32 = 0;
        let s = unsafe { NCryptSignHash(key.0, null(), digest.as_ptr(), digest.len() as u32, sig.as_mut_ptr(), sig.len() as u32, &mut got, 0) };
        if s != 0 || got != 64 { return Err("Not approved. Nothing was changed.".into()); }
        Ok(sig)
    }

    // ---- the agreement key: ECDH only, no prompt per use ----

    const AGREE_NAME: &str = "Vyre agreement key";

    /// The provider that holds (or will hold) the agreement key: the TPM when it will, else the software provider, whose keys CNG protects for this user (DPAPI). No prompt in either.
    fn agree_provider(name: &str) -> Result<Prov, String> {
        let mut h: Handle = 0;
        let n = w(name);
        if unsafe { NCryptOpenStorageProvider(&mut h, n.as_ptr(), 0) } != 0 { return Err("No key provider on this computer.".into()); }
        Ok(Prov(h))
    }

    fn agree_open() -> Option<(Prov, Key)> {
        for name in ["Microsoft Platform Crypto Provider", "Microsoft Software Key Storage Provider"] {
            if let Ok(p) = agree_provider(name) {
                let mut h: Handle = 0;
                let key = w(AGREE_NAME);
                if unsafe { NCryptOpenKey(p.0, &mut h, key.as_ptr(), 0, 0) } == 0 { return Some((p, Key(h))); }
            }
        }
        None
    }

    fn agree_make() -> Result<(Prov, Key), String> {
        for name in ["Microsoft Platform Crypto Provider", "Microsoft Software Key Storage Provider"] {
            let Ok(p) = agree_provider(name) else { continue };
            let mut h: Handle = 0;
            let alg = w("ECDH_P256");
            let key = w(AGREE_NAME);
            if unsafe { NCryptCreatePersistedKey(p.0, &mut h, alg.as_ptr(), key.as_ptr(), 0, 0) } != 0 { continue; }
            let k = Key(h);
            if unsafe { NCryptFinalizeKey(k.0, 0) } != 0 { continue; }
            return Ok((p, k));
        }
        Err("This computer would not make an agreement key.".into())
    }

    /// The agreement key's public point (65 bytes), made on first use when `create`.
    pub fn agree_public(create: bool) -> Result<[u8; 65], String> {
        let (_p, key) = match agree_open() { Some(x) => x, None if create => agree_make()?, None => return Err("There is no agreement key on this computer.".into()) };
        let blob_type = w("ECCPUBLICBLOB");
        let mut need: u32 = 0;
        if unsafe { NCryptExportKey(key.0, 0, blob_type.as_ptr(), null(), null_mut(), 0, &mut need, 0) } != 0 { return Err("The agreement key could not be read.".into()); }
        let mut blob = vec![0u8; need as usize];
        let mut got: u32 = 0;
        if unsafe { NCryptExportKey(key.0, 0, blob_type.as_ptr(), null(), blob.as_mut_ptr(), need, &mut got, 0) } != 0 { return Err("The agreement key could not be read.".into()); }
        blob.truncate(got as usize);
        vyre_capsule_win::identity::point_from_ecc_blob(&blob).ok_or_else(|| "The agreement key is not a P-256 key.".to_string())
    }

    /// The 32-byte ECDH shared secret (big-endian X) between the agreement key and a peer's raw uncompressed point.
    pub fn agree_secret(epk: &[u8]) -> Result<[u8; 32], String> {
        let peer_blob = vyre_capsule_win::identity::ecdh_blob_from_point(epk).ok_or_else(|| "That is not a public key.".to_string())?;
        let (p, key) = agree_open().ok_or_else(|| "There is no agreement key on this computer.".to_string())?;
        let blob_type = w("ECCPUBLICBLOB");
        let mut peer: Handle = 0;
        if unsafe { NCryptImportKey(p.0, 0, blob_type.as_ptr(), null(), &mut peer, peer_blob.as_ptr(), peer_blob.len() as u32, 0) } != 0 { return Err("That is not a public key.".into()); }
        let peer = Key(peer);
        let mut secret: Handle = 0;
        if unsafe { NCryptSecretAgreement(key.0, peer.0, &mut secret, 0) } != 0 { return Err("This computer could not open that.".into()); }
        let secret = Key(secret);
        // BCRYPT_KDF_RAW_SECRET ("TRUNCATE"): the raw shared secret, little-endian.
        let kdf = w("TRUNCATE");
        let mut out = [0u8; 32];
        let mut got: u32 = 0;
        if unsafe { NCryptDeriveKey(secret.0, kdf.as_ptr(), null(), out.as_mut_ptr(), 32, &mut got, 0) } != 0 || got != 32 { return Err("This computer could not open that.".into()); }
        vyre_capsule_win::identity::secret_big_endian(&out).ok_or_else(|| "This computer could not open that.".to_string())
    }
}

#[cfg(windows)]
pub use imp::{agree_public, agree_secret, public_point, sign};


#[cfg(not(windows))]
pub fn public_point(_create: bool) -> Result<[u8; 65], String> { Err("This computer has no TPM that Vyre can use.".into()) }
#[cfg(not(windows))]
pub fn sign(_message: &[u8]) -> Result<[u8; 64], String> { Err("There is no TPM key on this computer.".into()) }

#[cfg(not(windows))]
pub fn agree_public(_create: bool) -> Result<[u8; 65], String> { Err("There is no agreement key on this computer.".into()) }
#[cfg(not(windows))]
pub fn agree_secret(_epk: &[u8]) -> Result<[u8; 32], String> { Err("There is no agreement key on this computer.".into()) }
