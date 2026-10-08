// ActivityLink: one conversation's activity feed, live. It asks vyred for the chat's stream (stream.open, a one-use ticket and the path), opens the WebSocket on the unix socket as the
// "capsule" caller, and folds every frame into an ActivityFeed (Core) from the first one the log holds, so a conversation reopened after Lumen was closed shows the hand-off, the teammate's
// steps and the report-back it missed. Nothing is opened for a conversation that is not showing; a stream that cannot open leaves the feed empty and Lumen keeps its plain conversation.

import Combine
import Foundation

/// A frame crossing from the stream's reader thread to the main actor.
private struct FrameBox: @unchecked Sendable { let v: [String: Any] }

@MainActor
final class ActivityLink: ObservableObject {
    @Published private(set) var feed = ActivityFeed()
    private var stream: VyredStream?
    private var chat: String?
    private var gen = 0

    var isOpen: Bool { chat != nil }

    /// Start (or keep) following this chat.
    func open(chat: String, vyred: VyredClient) {
        if self.chat == chat { return }
        close()
        gen += 1
        let mine = gen
        self.chat = chat
        Task { @MainActor in
            let r = await vyred.call("stream.open", ["chat": chat, "from": 0], presence: false)
            guard mine == self.gen, Bridge.explain(r) == nil, let d = r.data as? [String: Any], let path = VJ.nonEmpty(d["path"]) else { return }
            let opened = await vyred.stream(path, onMessage: { [weak self] frame in
                let box = FrameBox(v: frame)
                Task { @MainActor in self?.heard(box.v, gen: mine) }
            }, onClose: {})
            guard mine == self.gen else { if case .success(let s) = opened { s.close() }; return }
            if case .success(let s) = opened { self.stream = s }
        }
    }

    func close() {
        gen += 1
        stream?.close(); stream = nil
        chat = nil
        if !feed.rows.isEmpty || feed.cursor != 0 { feed = ActivityFeed() }
    }

    func heard(_ frame: [String: Any], gen g: Int) {
        guard g == gen else { return }
        var next = feed
        if next.apply(frame) { feed = next }
    }
}
