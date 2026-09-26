import SwiftUI

/// Settings: the theme, the box this phone talks to, notifications, this phone's key, and sign out.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var health: JSON = .null
    @State private var keys: [JSON] = []
    @State private var confirming = false
    @State private var signingOut = false
    @State private var line: String?

    var body: some View {
        @Bindable var app = app
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                PageHead(eyebrow: "Settings", title: "This phone")
                section("Theme") {
                    ForEach(Theme.allCases) { t in
                        Button { app.theme = t } label: {
                            HStack {
                                Text(t.label).vyre(.body).foregroundStyle(Color.bone)
                                Spacer()
                                if app.theme == t { Image(systemName: "checkmark").foregroundStyle(Color.signal) }
                            }
                            .frame(minHeight: Space.target)
                            .contentShape(Rectangle())
                            .overlay(alignment: .bottom) { Hairline() }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(app.theme == t ? .isSelected : [])
                    }
                }
                section("Box") {
                    pair("Address", app.address?.display ?? "none")
                    pair("Status", app.online ? "reachable" : "offline")
                    pair("Version", health["version"].string)
                    pair("Stream", streamState)
                    Text("To use another box, sign out and sign in with its address.").vyre(.small).foregroundStyle(Color.ash).padding(.top, Space.s)
                }
                section("Notifications") {
                    pair("This phone", app.push.enabled ? "on" : "off")
                    if let s = app.push.status { Text(s).vyre(.small).foregroundStyle(Color.stone).padding(.vertical, Space.s) }
                    HStack(spacing: Space.s) {
                        if app.push.enabled {
                            Button("Send a test") { Task { await test() } }.buttonStyle(.secondary)
                            Button("Turn off") { Task { await app.push.unregister(client: app.client) } }.buttonStyle(.quiet)
                        } else {
                            Button("Turn on") { Task { await app.push.enable(client: app.client) } }.buttonStyle(.secondary)
                        }
                    }
                    .padding(.top, Space.s)
                    Text("A notification says only that something waits. The details come from the box when you open it.")
                        .vyre(.small).foregroundStyle(Color.ash).padding(.top, Space.s)
                }
                section("Presence") {
                    pair("This key", app.key.map { String($0.id.prefix(10)) })
                    pair("Held in", app.key.map { $0.isHardware ? "Secure Enclave" : "software (simulator)" })
                    ForEach(keys, id: \.self) { k in
                        ListRow(title: k["name"].string ?? k["id"].text, detail: k["kind"].string,
                                note: k["id"].string == app.key?.id ? "this phone" : age(k["last_used"].double), mono: true, chevron: false)
                    }
                    Text("Lost a phone? Remove its key from the Deck's Settings.").vyre(.small).foregroundStyle(Color.ash).padding(.top, Space.s)
                }
                if let line { Text(line).vyre(.small).foregroundStyle(Color.stone) }
                Button(signingOut ? "Signing out" : "Sign out of this box") { confirming = true }
                    .buttonStyle(.vyre(.secondary, fill: true))
                    .disabled(signingOut)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .confirmationDialog("Sign out of \(app.address?.display ?? "the box")?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await signOut() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone's key is removed from the box and deleted here, with everything the phone kept.")
        }
        .task { await load() }
    }

    private var streamState: String {
        switch app.hub.state {
        case .stopped: "closed"
        case .connecting: "connecting"
        case .live: "live"
        case .waiting(let s): "retrying in \(s) s"
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: title).padding(.bottom, Space.s)
            Hairline()
            content()
        }
    }

    @ViewBuilder
    private func pair(_ k: String, _ v: String?) -> some View {
        if let v, !v.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Engraved(k).frame(width: 96, alignment: .leading)
                Text(v).vyre(.code).foregroundStyle(Color.bone).lineLimit(1)
                Spacer()
            }
            .frame(minHeight: Space.target)
            .overlay(alignment: .bottom) { Hairline() }
        }
    }

    private func load() async {
        if let h = try? await app.client?.health() { health = h }
        if let k = try? await app.call("presence.keys") { keys = k.list }
    }

    private func test() async {
        do {
            let out = try await app.call("push.test", app.push.device.map { ["device": .string($0)] } ?? [:])
            line = "Sent \(out["sent"].int ?? 0), failed \(out["failed"].int ?? 0)."
        } catch { line = describe(error) }
    }

    private func signOut() async {
        signingOut = true
        defer { signingOut = false }
        await app.signOut()
    }
}
