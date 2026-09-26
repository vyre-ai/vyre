// Rows that are an answer in themselves (a sum, a conversion): Enter copies the answer and the
// Capsule closes, as in the Electron Capsule. ⌘C copies without closing.

import AppKit

extension CapsuleModel {
    /// A row with something to copy and nothing to run gets Copy as its Enter.
    func withCopy(_ r: ResultItem) -> ResultItem {
        guard r.actions.isEmpty, let text = r.copyText, !text.isEmpty else { return r }
        var x = r
        x.actions = [ResultAction(id: "copy", title: "Copy", symbol: "doc.on.doc") { _, _ in
            await MainActor.run {
                CapsuleModel.replyBoard.clearContents()
                CapsuleModel.replyBoard.setString(text, forType: .string)
            }
            return .close(nil)
        }]
        return x
    }

    /// vyred was looked for and is not there: say so, once, above what still works on this Mac.
    var offline: Bool { !vyred.isUp && vyred.follower.isWaiting }
}
