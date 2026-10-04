// VyreAppWindow: the Vyre app on the Mac. The 0.3 app's web build (apps/app, `expo export -p web`, which this Mac's own vyred serves at /app/) runs
// in a real window, a WKWebView, with the native things a web page cannot do: a menu bar, Command shortcuts, Touch ID answering the box's presence
// challenge, notifications from the shell, and drag and drop of files (WKWebView hands a dropped file to the page itself).
//
// The page never sees a port or a token. Its address is vyreapp://box/app/, and a WKURLSchemeHandler (BoxSchemeHandler) forwards every request
// the page makes (the app's own files, /v1/tools/<name>, the event stream) to vyred over its unix socket, as the "capsule" caller, so the web
// build is the same-origin page it already is. The window is Lumen's one regular-app surface: it makes Lumen a Dock app and gives it the full
// menu bar while it is open, and puts both back (accessory app, the standard-shortcuts menu) when it closes.
//
// The bridge is one message handler, "vyre", and window.__vyreShell on the page side (VyreAppBridge.js in apps/app/src/shell). Calls: presence
// (Touch ID, answered with CapsulePresence's x-vyre-presence header), notify, open (an https link in the browser). Native to page: a menu command
// is window.__vyreShell._command(path), which the app turns into a route change.

import AppKit
import WebKit

@MainActor
final class VyreAppWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let shared = VyreAppWindow()
    /// The page's address: the scheme, the one host, and where vyred serves the app.
    static let scheme = "vyreapp"
    static let start = URL(string: "vyreapp://box/app/")!

    /// Set by the Capsule at launch (App.swift).
    var socket = ""
    var presence: CapsulePresence?

    private(set) var window: NSWindow?
    private var web: WKWebView?
    private let proxy = BoxSchemeHandler()
    private var priorMenu: NSMenu?
    /// The page's open streams (the WebSocket relay below), by the id the page gave them.
    private var streams: [Int: VyredStream] = [:]
    private var presenceBusy = false

    var isOpen: Bool { window?.isVisible ?? false }

    /// Open the window, or bring it forward. Never starts anything else.
    func show() {
        if window == nil { build() }
        proxy.socket = socket
        proxy.isOurs = { [weak self] w in w === self?.web }
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        if priorMenu == nil { priorMenu = NSApp.mainMenu }
        NSApp.mainMenu = VyreMenu.make(self)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func build() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(proxy, forURLScheme: Self.scheme)
        cfg.userContentController.add(WeakScriptHandler(self), name: "vyre")
        cfg.userContentController.addUserScript(WKUserScript(source: Self.bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        web = view

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "Vyre"
        w.titlebarAppearsTransparent = true
        w.minSize = NSSize(width: 380, height: 560)
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = view
        w.setFrameAutosaveName("VyreApp")
        if w.frame.origin == .zero { w.center() }
        window = w
        view.load(URLRequest(url: Self.start))
    }

    func windowWillClose(_ notification: Notification) {
        web?.stopLoading()
        proxy.stopAll()
        for s in streams.values { s.close() }
        streams.removeAll()
        web = nil
        window = nil
        NSApp.mainMenu = priorMenu
        priorMenu = nil
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: Menu commands (VyreMenu.swift)

    /// A menu command to the app: a route ("/u/now"), or "back" and "forward".
    func command(_ name: String) {
        run("window.__vyreShell && window.__vyreShell._command(\(Self.js(name)))")
    }
    @objc func menuGo(_ sender: NSMenuItem) { if let p = sender.representedObject as? String { command(p) } }
    @objc func menuReload(_ sender: Any?) { web?.reload() }
    @objc func menuZoom(_ sender: NSMenuItem) {
        guard let web else { return }
        let step = sender.tag
        web.pageZoom = step == 0 ? 1 : max(0.5, min(3, web.pageZoom + (step > 0 ? 0.1 : -0.1)))
    }
    @objc func menuHelp(_ sender: Any?) { if let u = URL(string: "https://vyre.run") { NSWorkspace.shared.open(u) } }
    @objc func menuClose(_ sender: Any?) { window?.performClose(nil) }

    // MARK: The page's calls

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let op = body["op"] as? String else { return }
        let args = body["args"] as? [String: Any] ?? [:]
        let box = UncheckedBox(args)
        Task { @MainActor in await self.handle(id: id, op: op, args: box) }
    }

    private func handle(id: Int, op: String, args box: UncheckedBox) async {
        let args = box.value
        switch op {
        case "presence":
            // The words on the Touch ID sheet are the Capsule's own (defaultSummary of the tool and its input), never the page's: a script cannot ask for a proof
            // while the sheet reads something harmless. One ask at a time, and only while this window is the one the person is looking at.
            guard let p = presence, let tool = args["tool"] as? String else { return reply(id, ["error": "Touch ID is not set up on this Mac yet."]) }
            guard window?.isKeyWindow == true, NSApp.isActive else { return reply(id, ["error": "Bring the Vyre window to the front to approve this."]) }
            guard !presenceBusy else { return reply(id, ["error": "Another approval is waiting for you."]) }
            presenceBusy = true
            defer { presenceBusy = false }
            let input = args["input"] as? [String: Any] ?? [:]
            switch await p.proofFromAnyThread(tool: tool, input: UncheckedBox(input), summary: nil) {
            case .success(let header): reply(id, ["header": header])
            case .failure(let f): reply(id, ["error": f.message])
            }
        case "notify":
            Notifier.shared.post(title: args["title"] as? String ?? "Vyre", body: args["body"] as? String ?? "")
            reply(id, ["ok": true])
        case "ws.open":
            guard let sid = args["sid"] as? Int, let path = args["path"] as? String, let clean = BoxSchemeHandler.cleanPath(path.components(separatedBy: "?")[0]), clean.hasPrefix("/v1/streams/") else { return reply(id, ["error": "That is not a stream of this Vyre."]) }
            let sock = socket
            let result: Result<VyredStream, VyredStreamFailure> = await withCheckedContinuation { k in
                DispatchQueue.global(qos: .userInitiated).async {
                    k.resume(returning: VyredSocketStream.open(socket: sock, path: path,
                        onMessage: { obj in DispatchQueue.main.async { VyreAppWindow.shared.pushSocket(sid, "message", Self.json(obj)) } },
                        onClose: { DispatchQueue.main.async { VyreAppWindow.shared.pushSocket(sid, "close", "null"); VyreAppWindow.shared.streams[sid] = nil } }))
                }
            }
            switch result {
            case .success(let st): streams[sid] = st; reply(id, ["ok": true])
            case .failure(let f): reply(id, ["error": f.message])
            }
        case "ws.send":
            if let sid = args["sid"] as? Int, let text = args["data"] as? String, let d = text.data(using: .utf8),
               let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] { streams[sid]?.sendJSON(obj) }
            reply(id, ["ok": true])
        case "ws.close":
            if let sid = args["sid"] as? Int { streams[sid]?.close(); streams[sid] = nil }
            reply(id, ["ok": true])
        default:
            reply(id, ["error": "Unknown call \(op)."])
        }
    }

    /// A stream event to the page: kind "message" (data is the frame's JSON) or "close".
    private func pushSocket(_ sid: Int, _ kind: String, _ data: String) { run("window.__vyreShell && window.__vyreShell._ws(\(sid), \(Self.js(kind)), \(data))") }

    private func reply(_ id: Int, _ value: [String: Any]) { run("window.__vyreShell && window.__vyreShell._reply(\(id), \(Self.json(value)))") }
    private func run(_ script: String) { web?.evaluateJavaScript(script, completionHandler: nil) }

    static func json(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return "null" }
        return s
    }
    static func js(_ s: String) -> String { json([s]).dropFirst().dropLast().description }

    // MARK: Navigation and files

    /// The page stays inside vyreapp://; an https link opens in the person's browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Self.scheme || url.scheme == "about" { return decisionHandler(.allow) }
        // An https link opens in the browser only when the person clicked it in the main frame; a script cannot open anything.
        if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame ?? true, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// A page's file input: the system's open panel. (A file dragged onto the page reaches it as a drop event with no help from here.)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// The page the bridge makes: window.__vyreShell.
    static let bridgeSource = """
    (function () {
      if (window.__vyreShell) return;
      var pending = {}, next = 1, commands = [], sockets = {}, nextSocket = 1;
      function call(op, args) {
        return new Promise(function (resolve, reject) {
          var id = next++;
          pending[id] = { resolve: resolve, reject: reject };
          window.webkit.messageHandlers.vyre.postMessage({ id: id, op: op, args: args || {} });
        });
      }
      window.__vyreShell = {
        kind: "mac",
        presence: function (tool, input, summary) { return call("presence", { tool: tool, input: input, summary: summary }).then(function (r) { return r.header; }); },
        notify: function (title, body) { return call("notify", { title: title, body: body }); },
        // A WebSocket-like object for one of vyred's streams, backed by the native relay (VyreAppWindow.swift): the page's chat and terminal streams use it.
        socket: function (path) {
          var sid = nextSocket++, ws = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
          sockets[sid] = ws;
          ws.send = function (data) { if (ws.readyState === 1) call("ws.send", { sid: sid, data: String(data) }); };
          ws.close = function () { if (ws.readyState < 2) { ws.readyState = 2; call("ws.close", { sid: sid }); } };
          return call("ws.open", { sid: sid, path: path }).then(function () {
            ws.readyState = 1; if (ws.onopen) ws.onopen({});
            return ws;
          }, function (e) { delete sockets[sid]; throw e; });
        },
        onCommand: function (fn) { commands.push(fn); return function () { commands = commands.filter(function (f) { return f !== fn; }); }; },
        _reply: function (id, value) { var p = pending[id]; if (!p) return; delete pending[id]; if (value && value.error) p.reject(new Error(value.error)); else p.resolve(value); },
        _ws: function (sid, kind, data) {
          var ws = sockets[sid]; if (!ws) return;
          if (kind === "message") { if (ws.onmessage) ws.onmessage({ data: JSON.stringify(data) }); }
          else { ws.readyState = 3; delete sockets[sid]; if (ws.onclose) ws.onclose({}); }
        },
        _command: function (name) { commands.forEach(function (f) { try { f(name); } catch (e) {} }); }
      };
    })();
    """
}

/// WKUserContentController retains its handlers: hold the window controller weakly so closing releases everything.
@MainActor private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: VyreAppWindow?
    init(_ t: VyreAppWindow) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) { target?.userContentController(c, didReceive: message) }
}

// MARK: - The page's requests, to vyred

/// vyreapp://box/<path> is vyred's <path>: the build's files at /app/, the tool calls, the event stream. One request per task, blocking on a background
/// queue, as the Capsule's own VyredClient does; a long stream stays open until the page stops it.
final class BoxSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    var socket = ""
    /// Only the Vyre app window's own web view may use this handler: the scheme is registered on that configuration alone, and this checks it again.
    var isOurs: (WKWebView) -> Bool = { _ in false }
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    // At most this many requests at once, so a page that loops cannot hold every thread (streams are counted apart: the app opens a few).
    private var running = 0, streaming = 0
    static let maxRequests = 32, maxStreams = 8
    private func take(stream: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if stream { guard streaming < Self.maxStreams else { return false }; streaming += 1 }
        else { guard running < Self.maxRequests else { return false }; running += 1 }
        return true
    }
    private func release(stream: Bool) { lock.lock(); if stream { streaming -= 1 } else { running -= 1 }; lock.unlock() }

    /// The request path as one safe string, or nil: no ".." or "." segment, no empty segment, no backslash or control character, and no encoded dot, slash or backslash
    /// (%2e %2f %5c, in any case), so what is checked is what vyred sees. @param raw the percent-encoded path
    static func cleanPath(_ raw: String) -> String? {
        let path = raw.isEmpty ? "/" : raw
        guard path.hasPrefix("/"), !path.contains("\\"), !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        let lower = path.lowercased()
        for bad in ["%2e", "%2f", "%5c", "%00"] where lower.contains(bad) { return nil }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        for (i, seg) in segments.enumerated() {
            if seg == "." || seg == ".." { return nil }
            if seg.isEmpty && i != segments.count - 1 { return nil }   // an empty segment in the middle (//); a trailing slash is fine
        }
        return path
    }

    /// What the page may reach: the app's own files and vyred's API.
    static func allowed(_ clean: String) -> Bool { clean == "/app" || clean.hasPrefix("/app/") || clean.hasPrefix("/v1/") }

    func stopAll() { lock.lock(); stopped.removeAll(); lock.unlock() }
    private func isStopped(_ t: WKURLSchemeTask) -> Bool { lock.lock(); defer { lock.unlock() }; return stopped.contains(ObjectIdentifier(t)) }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock() }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard isOurs(webView), let url = task.request.url, url.host == "box", !socket.isEmpty else { return task.didFailWithError(URLError(.cannotConnectToHost)) }
        let method = task.request.httpMethod ?? "GET"
        let body = BoxSchemeHandler.body(of: task.request)
        var headers: [String: String] = [:]
        for k in ["x-vyre-presence", "x-vyre-presence-keep", "idempotency-key", "last-event-id"] { if let v = task.request.value(forHTTPHeaderField: k) { headers[k] = v } }
        let accept = task.request.value(forHTTPHeaderField: "Accept") ?? "*/*"
        let stream = accept.contains("text/event-stream")
        guard take(stream: stream) else { return task.didFailWithError(URLError(.resourceUnavailable)) }
        let sock = socket
        let id = ObjectIdentifier(task)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var sent = false
            let result = VyHTTP.exchange(socket: sock, method: method, path: path, body: body, timeout: stream ? 24 * 3600 : 60, headers: headers, accept: accept,
                onHead: { head in
                    var h: [String: String] = [:]
                    for (k, v) in head.headers where !["transfer-encoding", "content-length", "connection"].contains(k) { h[k] = v }
                    DispatchQueue.main.async {
                        guard !self.isStopped(task) else { return }
                        sent = true
                        let fallback = URLResponse(url: url, mimeType: nil, expectedContentLength: -1, textEncodingName: nil)
                        let response: URLResponse = HTTPURLResponse(url: url, statusCode: head.status, httpVersion: "HTTP/1.1", headerFields: h) ?? fallback
                        task.didReceive(response)
                    }
                },
                onBody: { data in
                    DispatchQueue.main.async { if !self.isStopped(task) { task.didReceive(data) } }
                })
            DispatchQueue.main.async {
                self.lock.lock(); let gone = self.stopped.remove(id) != nil; self.lock.unlock()
                self.release(stream: stream)
                if gone { return }
                switch result {
                case .success: if sent { task.didFinish() } else { task.didFailWithError(URLError(.badServerResponse)) }
                case .failure: task.didFailWithError(URLError(.cannotConnectToHost))
                }
            }
        }
    }

    /// The request's body, from its data or its stream.
    static func body(of request: URLRequest) -> Data? {
        if let d = request.httpBody { return d }
        guard let s = request.httpBodyStream else { return nil }
        s.open(); defer { s.close() }
        var out = Data(), buf = [UInt8](repeating: 0, count: 16 * 1024)
        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out.append(buf, count: n) }
        return out
    }
}
