// VyreAppWindow, for Vyre in Finder: one server call made from the page that holds this Mac's device channel. The page offers it as window.__vyreMount.call (apps/app/src/shell/mount-bridge.ts);
// it answers { data } or { error: { code, message } }, so a refusal from the server reaches the Finder extension with its own code.

import Foundation
import WebKit

extension VyreAppWindow {
    /// Hand the mount bridge a way to call the server through the page. Not a closure over self: the window may be made and closed again.
    func installMountCaller() {
        MountBridge.shared.caller = { tool, input in
            await VyreAppWindow.shared.callFromPage(tool, input)
        }
    }

    @MainActor
    func callFromPage(_ tool: String, _ input: [String: Any]) async -> [String: Any] {
        guard let web else { return ["error": ["code": "no_app", "message": "Vyre's window is not running."]] }
        do {
            let r = try await web.callAsyncJavaScript("return await window.__vyreMount.call(tool, input);", arguments: ["tool": tool, "input": input], in: nil, contentWorld: .page)
            return (r as? [String: Any]) ?? ["error": ["code": "bad_answer", "message": "The page gave no answer."]]
        } catch {
            return ["error": ["code": "no_page", "message": "The page could not make the call."]]
        }
    }
}
