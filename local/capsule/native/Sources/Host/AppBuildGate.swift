// AppBuildGate: the web app this Mac's vyred serves at /app/ is the code that runs inside Lumen's window, which holds Touch ID, and the install is writable by the
// person's own user. So the window checks it itself (the daemon refuses an unlisted file too, for every client; this is the check that does not trust the daemon):
//
//   1. vyred's system.build tool returns the release's SHA256SUMS text, its signature (SHA256SUMS.sig, Ed25519 over "vyre-release-sums\n" + SHA256SUMS) and
//      appbuild.json, which maps every file of the exported web build to its sha256 and gives one tree hash.
//   2. The signature must verify with the release public key compiled into Lumen (releaseKeySPKI, ReleaseKey.generated.swift), and appbuild.json's own sha256 must be
//      a line of that signed list.
//   3. Every /app/ body the scheme handler serves is hashed and must equal its entry. A changed or unlisted file is refused (403), and so is anything while the list
//      has not verified. The one allowance is the single-page app's fallback: a route like /app/u/now is served index.html, so an unlisted path is accepted only
//      when its body is exactly the listed index.html.
//
// A development build that has no signed list is built with VYRE_LUMEN_RELEASE_KEY set to the placeholder key (build.sh), which turns the check off; a release is
// refused by scripts/check-release-key.mjs for carrying that key.

import CryptoKit
import Foundation

struct AppBuild: Equatable, Sendable {
    var files: [String: String]
    var tree: String
}

enum AppBuildGate {
    /// The placeholder key (scripts/check-release-key.mjs PLACEHOLDER): a build with it has no signed list and serves the app unchecked.
    static let placeholderKey = "MCowBQYDK2VwAyEAfFTFccqQNhkHQ3II6EniEoRfWgDDDjQn+GKEJZQIHoE="

    enum Outcome: Equatable, Sendable {
        case verified(AppBuild)
        /// Development build: no check.
        case unchecked
        case refused(String)
    }

    static func publicKey(spki: String) -> Curve25519.Signing.PublicKey? {
        let prefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
        guard let der = Data(base64Encoded: spki), der.count == 44, der.prefix(12) == prefix else { return nil }
        return try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
    }

    static func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    /// The signed list, checked. `key` is the SPKI the build was made with.
    static func verify(appbuild: Data, sums: String, sig: Data, key: String) -> Outcome {
        if key == placeholderKey { return .unchecked }
        guard let pub = publicKey(spki: key) else { return .refused("This Vyre was built without a valid release key.") }
        guard pub.isValidSignature(sig, for: Data(("vyre-release-sums\n" + sums).utf8)) else { return .refused("The release list is not signed by Vyre's key.") }
        let want = sha256Hex(appbuild)
        let listed = sums.split(whereSeparator: \.isNewline).contains { line in
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            return parts.count == 2 && parts[0].lowercased() == want && parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "*")) == "appbuild.json"
        }
        guard listed else { return .refused("The app build is not in the signed release list.") }
        guard let j = VJ.decode(appbuild) as? [String: Any], let files = j["files"] as? [String: String], !files.isEmpty, let index = files["index.html"], !index.isEmpty else {
            return .refused("The app build list is unreadable.")
        }
        return .verified(AppBuild(files: files.mapValues { $0.lowercased() }, tree: VJ.s(j["tree"])))
    }

    /// The listed name of a served path: "/app/" is index.html, "/app/_expo/x.js" is "_expo/x.js". nil for anything outside /app/. The path has no query.
    static func listedName(_ path: String) -> String? {
        guard path == "/app" || path.hasPrefix("/app/") else { return nil }
        var rel = String(path.dropFirst(4))
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty || rel.hasSuffix("/") { rel += "index.html" }
        return rel
    }

    /// May this body be served for this path? A listed file must match its hash; an unlisted path is a route of the single-page app and must be exactly index.html.
    static func allows(_ build: AppBuild, path: String, body: Data) -> Bool {
        guard let name = listedName(path) else { return false }
        let h = sha256Hex(body)
        if let want = build.files[name] { return want == h }
        return build.files["index.html"] == h
    }

    /// Ask vyred for the list and verify it. Blocking: call off the main thread.
    static func fetch(socket: String, key: String = releaseKeySPKI) -> Outcome {
        if key == placeholderKey { return .unchecked }
        switch VyHTTP.exchange(socket: socket, method: "POST", path: "/v1/tools/system.build", body: Data("{}".utf8), timeout: 10) {
        case .failure: return .refused("Vyre did not give the signed app list.")
        case .success(let (status, body)):
            guard status == 200, let j = VJ.decode(body) as? [String: Any], let d = j["data"] as? [String: Any],
                  let ab = d["appbuild"] as? String, let sums = d["sums"] as? String, let sig = (d["sig"] as? String).flatMap({ Data(base64Encoded: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }) else {
                return .refused("This Vyre has no signed app build list.")
            }
            return verify(appbuild: Data(ab.utf8), sums: sums, sig: sig, key: key)
        }
    }
}
