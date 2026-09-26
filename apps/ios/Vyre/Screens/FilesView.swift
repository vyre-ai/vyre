import SwiftUI
import UIKit

/// A file from the box, opened from Find's Files results: `files.preview`, and a copy saved in
/// chunks with `files.fetch`. Over the tailnet the phone reaches only the box (CONTRACT.md 5).
/// Nothing here is cached.
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
        PullScroll {
            VStack(alignment: .leading, spacing: Space.l) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(file["name"].text).vyre(.h2).foregroundStyle(Color.text)
                    Text(file["path"].text).vyre(.codeSmall).foregroundStyle(Color.label).textSelection(.enabled)
                    Text([file["kind"].string, byteSize(file["size"].double), file["mtime"].string.map { String($0.prefix(10)) }]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .vyre(.codeSmall).foregroundStyle(Color.text2)
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
                Text(text).vyre(.codeSmall).foregroundStyle(Color.text).textSelection(.enabled)
                    .padding(Space.m)
            }
            .background(Color.codeBg, in: RoundedRectangle(cornerRadius: Radius.button))
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
            Text("The copy stays in a temporary folder until you leave this screen.").vyre(.small).foregroundStyle(Color.label)
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
