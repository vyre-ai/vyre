import SwiftUI
import UIKit

/// Files: search what the box holds (`files.search`), preview it (`files.preview`) and save a
/// copy in chunks (`files.fetch`). Over the tailnet the phone reaches only the box: the Mac shows
/// as a row that says so (ADR 0018 section 2, CONTRACT.md 5). Nothing here is cached.
struct FilesView: View {
    @Environment(AppModel.self) private var app
    @State private var q = ""
    @State private var results: [JSON] = []
    @State private var sources: [JSON] = []
    @State private var searched = false
    @State private var loading = false
    @State private var problem: String?
    @State private var kind: String?

    static let kinds = ["text", "code", "doc", "pdf", "image", "folder"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    PageHead(eyebrow: "Files", title: "Find a file.")
                    SearchField(text: $q, prompt: "Northwind invoice, harlow.pdf", submit: { Task { await search() } })
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Space.s) {
                            chip(nil, "All")
                            ForEach(FilesView.kinds, id: \.self) { chip($0, $0) }
                        }
                    }
                    devices
                    VStack(alignment: .leading, spacing: 0) {
                        if searched || loading {
                            SectionHead(title: "Results", note: results.isEmpty ? nil : "\(results.count)").padding(.bottom, Space.s)
                            Hairline()
                        }
                        LoadState(loading: loading, problem: problem,
                                  empty: searched && results.isEmpty ? "Nothing on the box matches \"\(q)\"." : nil)
                        ForEach(results, id: \.self) { f in
                            NavigationLink(value: f) {
                                ListRow(title: f["name"].text, detail: f["path"].text,
                                        note: [f["kind"].string, byteSize(f["size"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
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
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: JSON.self) { f in FilePreview(file: f) }
        }
        .task(id: kind) { if searched { await search() } }
    }

    private func chip(_ k: String?, _ label: String) -> some View {
        let on = kind == k
        return Button { kind = k } label: {
            Text(label).vyre(.label).tracking(1.3)
                .foregroundStyle(on ? Color.signalInk : Color.stone)
                .padding(.horizontal, Space.m)
                .frame(minHeight: 32)
                .background(on ? Color.signalFill : Color.panel, in: RoundedRectangle(cornerRadius: Radius.chip))
                .overlay { if !on { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.ruleStrong, lineWidth: 1) } }
        }
        .buttonStyle(.plain)
    }

    /// Where files come from. The box answers; the Mac is not reachable from a phone yet.
    private var devices: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Devices").padding(.bottom, Space.s)
            Hairline()
            let box = sources.first { $0["source"].string == "box" }
            ListRow(title: app.address?.display ?? "The box",
                    detail: box.map { b in b["ok"].bool == false ? (b["error"].string ?? "Did not answer.") : (b["note"].string ?? "Searched.") } ?? "The box's files, under /work.",
                    note: box?["count"].int.map { plural($0, "match") } ?? "box",
                    dot: box?["ok"].bool == false ? .ash : .signal, mono: true, chevron: false)
            ListRow(title: "Mac", detail: "Reachable through the box once linking lands. Until then a phone sees only the box.",
                    note: "not linked", dot: .ash, mono: true, chevron: false)
        }
    }

    private func search() async {
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return }
        loading = true
        defer { loading = false }
        var input: JSON = ["q": .string(s), "limit": 100]
        if let kind { input = input.with("kinds", JSON([kind])) }
        do {
            let out = try await app.call("files.search", input)
            results = out["results"].list
            sources = out["sources"].list
            problem = nil
        } catch {
            results = []
            problem = describe(error)
        }
        searched = true
    }
}

/// One file: its preview (text or an image), what it is, and a way to save a copy on the phone.
struct FilePreview: View {
    @Environment(AppModel.self) private var app
    let file: JSON
    @State private var preview: JSON = .null
    @State private var image: UIImage?
    @State private var loading = true
    @State private var problem: String?
    @State private var saved: URL?
    @State private var progress: Double?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(file["name"].text).vyre(.h2).foregroundStyle(Color.bone)
                    Text(file["path"].text).vyre(.codeSmall).foregroundStyle(Color.ash).textSelection(.enabled)
                    Text([file["kind"].string, byteSize(file["size"].double), file["mtime"].string.map { String($0.prefix(10)) }]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .vyre(.codeSmall).foregroundStyle(Color.stone)
                }
                LoadState(loading: loading, problem: problem, empty: nil)
                content
                if file["kind"].string != "folder" { saveRow }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .task { await load() }
        .onDisappear { if let saved { try? FileManager.default.removeItem(at: saved.deletingLastPathComponent()) } }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image).resizable().scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: Radius.panel))
            if preview["thumbnail"].bool == true { Engraved("Thumbnail, 512 px") }
        } else if let text = preview["text"].string {
            ScrollView(.horizontal) {
                Text(text).vyre(.codeSmall).foregroundStyle(Color.bone).textSelection(.enabled)
                    .padding(Space.m)
            }
            .background(Color.codeGround, in: RoundedRectangle(cornerRadius: Radius.button))
            if preview["truncated"].bool == true { Engraved("Only the start is shown") }
        } else if !loading && problem == nil {
            EmptyLine(text: preview["note"].string ?? "No preview for this kind of file. Save a copy to open it.")
        }
    }

    private var saveRow: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let saved {
                ShareLink(item: saved) { Label("Share or save", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.vyre(.primary, fill: true))
            } else {
                Button { Task { await fetch() } } label: {
                    Text(progress.map { "Fetching \(Int($0 * 100))%" } ?? "Get a copy")
                }
                .buttonStyle(.secondary)
                .disabled(progress != nil)
            }
            Text("The copy stays in a temporary folder until you leave this screen.").vyre(.small).foregroundStyle(Color.ash)
        }
    }

    private func load() async {
        defer { loading = false }
        guard file["kind"].string != "folder" else { return }
        do {
            let out = try await app.call("files.preview", ["path": file["path"], "source": .string(file["source"].string ?? "box")])
            preview = out
            if let b = out["base64"].string, let d = Data(base64Encoded: b) { image = UIImage(data: d) }
        } catch { problem = describe(error) }
    }

    /// `files.fetch` in 1 MiB chunks, checking the file does not change underneath.
    private func fetch() async {
        let chunk = 1_048_576
        var data = Data()
        var offset = 0
        var size: Int?
        var mtime: String?
        progress = 0
        defer { progress = nil }
        do {
            while true {
                let out = try await app.call("files.fetch", ["path": file["path"], "offset": JSON(offset), "length": JSON(chunk)])
                if let s = size, s != out["size"].int || mtime != out["mtime"].string {
                    problem = "The file changed while it was being fetched. Try again."
                    return
                }
                size = out["size"].int
                mtime = out["mtime"].string
                guard let b = out["base64"].string, let d = Data(base64Encoded: b) else { problem = "The box sent no bytes."; return }
                data.append(d)
                offset += d.count
                if let size, size > 0 { progress = Double(offset) / Double(size) }
                if out["done"].bool == true || d.isEmpty { break }
            }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(file["name"].string ?? "file")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            saved = url
        } catch { problem = describe(error) }
    }
}
