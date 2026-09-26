import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Vault: names, kinds and hosts from `vault.list`. No value is ever fetched without a device
/// proof for it (floor rule 8), and none is cached (ADR 0018 sections 6 and 7).
struct VaultView: View {
    @Environment(AppModel.self) private var app
    @State private var items: [JSON] = []
    @State private var locked = false
    @State private var q = ""
    @State private var loading = true
    @State private var problem: String?

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.l) {
                PageHead(eyebrow: "Vault", title: "Secrets", sub: locked ? "The vault is locked on the box. Unlock it from the Deck or the Mac." : "Names only. A value shows after Face ID, for that one item.")
                SearchField(text: $q, prompt: "Filter by name or host")
                VStack(alignment: .leading, spacing: 0) {
                    Hairline()
                    LoadState(loading: loading && items.isEmpty, problem: problem, empty: shown.isEmpty ? (q.isEmpty ? "The vault is empty." : "Nothing matches \(q).") : nil)
                    ForEach(shown, id: \.self) { it in
                        NavigationLink(value: Dest.vaultItem(it["name"].text)) {
                            ListRow(title: it["name"].text,
                                    detail: it["hosts"].strings.isEmpty ? it["description"].string : it["hosts"].strings.joined(separator: ", "),
                                    note: it["kind"].string, dot: it["stale"].bool == true ? .label : nil, mono: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .task { await load() }
    }

    private var shown: [JSON] {
        let s = q.lowercased().trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return items }
        return items.filter { $0["name"].text.lowercased().contains(s) || $0["hosts"].strings.contains { $0.lowercased().contains(s) } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let out = try await app.call("vault.list")
            items = out["items"].list.sorted { $0["name"].text < $1["name"].text }
            locked = out["locked"].bool == true
            problem = nil
        } catch { problem = describe(error) }
    }
}

/// One vault item: its fields, each hidden until revealed with Face ID. A shown value hides
/// itself after the box's `concealAfter`, and when the app leaves the screen.
struct VaultItemView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let name: String
    @State private var item: JSON = .null
    @State private var shown: [String: String] = [:]
    @State private var totp: JSON = .null
    @State private var busy: String?
    @State private var problem: String?
    @State private var line: String?
    @State private var conceal: [String: Task<Void, Never>] = [:]

    static let defaults = ["secret": "value", "api-key": "value", "login": "password", "card": "number", "note": "text"]
    static let totpKey = "__totp"

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.xl) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Engraved(item["kind"].string ?? "Item")
                    Text(name).vyre(.h2).foregroundStyle(Color.text)
                    if let d = item["description"].string, !d.isEmpty { Text(d).vyre(.small).foregroundStyle(Color.text2) }
                }
                if let problem { FailedLine(text: problem) }
                if let line { Text(line).vyre(.small).foregroundStyle(Color.text2) }
                VStack(alignment: .leading, spacing: 0) {
                    SectionHead(title: "Fields").padding(.bottom, Space.s)
                    Hairline()
                    ForEach(fields, id: \.self) { f in fieldRow(f) }
                    if item["otp"].bool == true { totpRow }
                }
                details
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .task { await load() }
        .onDisappear { hideAll() }
        .onChange(of: scenePhase) { _, p in if p != .active { hideAll() } }
    }

    private var fields: [String] {
        let fs = item["fields"].strings.filter { $0 != "totp" }
        let d = VaultItemView.defaults[item["kind"].string ?? ""]
        return fs.sorted { a, b in a == d ? true : b == d ? false : a < b }
    }

    private func fieldRow(_ f: String) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline) {
                Engraved(f)
                Spacer()
                if shown[f] != nil {
                    Button("Hide") { hide(f) }.buttonStyle(.quiet)
                } else {
                    Button(busy == f ? "Checking" : "Reveal") { Task { await reveal(f) } }.buttonStyle(.quiet).disabled(busy != nil)
                }
                Button("Copy") { Task { await copy(f) } }.buttonStyle(.quiet).disabled(busy != nil)
            }
            Text(shown[f] ?? "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}")
                .vyre(.code)
                .foregroundStyle(shown[f] == nil ? Color.label : Color.text)
                .textSelection(.disabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(shown[f] == nil ? "\(f), hidden" : "\(f), shown")
        }
        .padding(.vertical, Space.m)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var totpRow: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Engraved("One-time code")
                Spacer()
                Button(busy == VaultItemView.totpKey ? "Checking" : "Show code") { Task { await code() } }.buttonStyle(.quiet).disabled(busy != nil)
            }
            if let c = totp["code"].string {
                HStack(alignment: .firstTextBaseline) {
                    Text(c).vyre(.hero).foregroundStyle(Color.text)
                    Spacer()
                    if let r = totp["remaining"].int { Engraved("\(r) s") }
                }
            }
        }
        .padding(.vertical, Space.m)
        .overlay(alignment: .bottom) { Hairline() }
    }

    @ViewBuilder
    private var details: some View {
        let hosts = item["hosts"].strings
        let grants = item["grants"].list.compactMap { $0["module"].string }
        if !hosts.isEmpty || !grants.isEmpty || item["url"].string != nil {
            VStack(alignment: .leading, spacing: 0) {
                SectionHead(title: "Where it is used").padding(.bottom, Space.s)
                Hairline()
                if let u = item["url"].string { ListRow(title: u, detail: "URL", mono: true, chevron: false) }
                if !hosts.isEmpty { ListRow(title: hosts.joined(separator: ", "), detail: "Hosts", mono: true, chevron: false) }
                if !grants.isEmpty { ListRow(title: grants.joined(separator: ", "), detail: "Modules it is granted to", mono: true, chevron: false) }
                if let w = item["staleWhy"].string { ListRow(title: w, detail: "Stale", chevron: false) }
            }
        }
    }

    // MARK: presence and values

    private func load() async {
        do {
            let out = try await app.call("vault.item", ["name": .string(name)])
            item = out["item"]
        } catch {
            // vault.item may be refused to a phone: the list row carries the same fields, without otp.
            if let list = try? await app.call("vault.list"), let it = list["items"].list.first(where: { $0["name"].string == name }) { item = it }
            else { problem = describe(error) }
        }
    }

    /// One Face ID opens a presence session (`presence.session.open`, bound to this phone, 5 minutes
    /// idle), so several reveals in a row do not each ask again. If the box will not open one, each
    /// value is proved on its own.
    private func ensureSession() async {
        if await app.sessions.isOpen { return }
        guard let out = try? await app.call("presence.session.open", [:], proof: .device(reason: "Open the vault on this phone")),
              let id = out["session"].string, let secret = out["secret"].string else { return }
        let expires = out["expires"].date ?? Date().addingTimeInterval(1800)
        let idle = (out["idle"].double ?? 300_000) / 1000
        await app.sessions.set(PresenceSessions.Open(id: id, secret: secret, expires: expires, idle: idle, used: Date()))
    }

    private func proved(_ tool: String, _ input: JSON, reason: String) async throws -> JSON {
        await ensureSession()
        do {
            return try await app.call(tool, input, proof: .session(reason: reason))
        } catch VyreError.presenceRequired {
            // A reprompt item, or a session the box ended: prove this one call with Face ID.
            await app.sessions.set(nil)
            return try await app.call(tool, input, proof: .device(reason: reason))
        }
    }

    private func value(_ f: String) async throws -> (String, Int) {
        let out = try await proved("vault.reveal", ["name": .string(name), "field": .string(f)], reason: "Reveal \(f) of \(name)")
        return (out["value"].text, out["concealAfter"].int ?? 30)
    }

    private func reveal(_ f: String) async {
        busy = f
        defer { busy = nil }
        problem = nil
        do {
            let (v, after) = try await value(f)
            shown[f] = v
            app.secretOnScreen = true
            schedule(f, after)
        } catch where isCancel(error) {
        } catch { problem = describe(error) }
    }

    /// The value goes on this phone's pasteboard only: local, never Handoff, gone after a minute.
    /// `vault.copy` would put it on the box's clipboard instead.
    private func copy(_ f: String) async {
        busy = f
        defer { busy = nil }
        problem = nil
        do {
            let v: String
            if let s = shown[f] { v = s } else { v = try await value(f).0 }
            UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: v]],
                                          options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
            line = "Copied \(f). It leaves the clipboard in a minute and never goes to your other devices."
            Haptics.success()
        } catch where isCancel(error) {
        } catch { problem = describe(error) }
    }

    private func code() async {
        busy = VaultItemView.totpKey
        defer { busy = nil }
        problem = nil
        do {
            totp = try await proved("vault.totp", ["name": .string(name)], reason: "One-time code for \(name)")
            app.secretOnScreen = true
            schedule(VaultItemView.totpKey, totp["remaining"].int ?? 30)
        } catch where isCancel(error) {
        } catch { problem = describe(error) }
    }

    private func schedule(_ key: String, _ seconds: Int) {
        conceal[key]?.cancel()
        conceal[key] = Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(1, seconds)))
            if !Task.isCancelled { hide(key) }
        }
    }

    private func hide(_ key: String) {
        conceal[key]?.cancel()
        conceal[key] = nil
        if key == VaultItemView.totpKey { totp = .null } else { shown[key] = nil }
        if shown.isEmpty && totp.isNull { app.secretOnScreen = false }
    }

    private func hideAll() {
        for t in conceal.values { t.cancel() }
        conceal = [:]
        shown = [:]
        totp = .null
        app.secretOnScreen = false
    }
}
