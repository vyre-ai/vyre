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
    /// This Mac's identity key (MacIdentity.swift), set by the Capsule at launch; the page signs through it and never sees the seed.
    var identity: MacIdentity?
    /// The Secure Enclave key of this Mac's device entry (MacEnclave.swift).
    var enclave: MacEnclave?
    /// This Mac's agreement key (MacAgree.swift): ECDH for opening a wrapped chat key, no prompt per use.
    var agreement: MacAgree?
    /// Settings' "Make this Mac a server": runs this Mac's own setup (FirstRunWindow.swift). Set by the Capsule at launch.
    var makeServer: (() -> Void)?
    /// The shell's own yes before the page may wipe this Mac's identity key (reviewer-3 LOW): a native alert the page cannot draw over. A fake in tests.
    var confirmForget: () -> Bool = {
        let a = NSAlert()
        a.messageText = "Forget this Mac's key?"
        a.informativeText = "This Mac will no longer be able to sign in to your name. You can get back in with your recovery code or another device."
        a.addButton(withTitle: "Forget it")
        a.addButton(withTitle: "Keep it")
        return a.runModal() == .alertFirstButtonReturn
    }

    /// A server Mac (FirstRun.swift): no local vyred, so the window serves the web build inside this app and the page connects to its server over the relay.
    private(set) var boxless = false

    private(set) var window: NSWindow?
    private var web: WKWebView?
    private let proxy = BoxSchemeHandler()
    /// The page's open streams (BoxSocket.swift), by the id the page's WebSocket shim gave them.
    private var sockets: [Int: BoxSocket] = [:]
    private var priorMenu: NSMenu?

    var isOpen: Bool { window?.isVisible ?? false }

    /// Open the window, or bring it forward. Never starts anything else. `boxless` is a server Mac's window (the web build carried in this app, no vyred socket);
    /// a window already open in the other mode is closed and made again.
    func show(boxless: Bool = false) {
        if window != nil, self.boxless != boxless { window?.close() }
        self.boxless = boxless
        if window == nil { build() }
        proxy.socket = socket
        proxy.bundleDir = boxless ? BundledApp.locate() : nil
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
        // A boxless window says so before the bridge is made, so the page can start as a browser with no box of its own.
        if boxless { cfg.userContentController.addUserScript(WKUserScript(source: "window.__vyreBoxless = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        // The app's version, for the page to show the line that matches it (a release candidate's install line differs from a stable one's).
        cfg.userContentController.addUserScript(WKUserScript(source: Self.versionScript(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // A WebSocket cannot ride a custom scheme: the page's WebSocket is replaced by one the app opens on vyred's socket (a server Mac has no vyred socket to open).
        if !boxless { cfg.userContentController.addUserScript(WKUserScript(source: Self.wsShimSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        cfg.userContentController.addUserScript(WKUserScript(source: Self.bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: cfg)
        // `defaults write sh.vyre.capsule inspect -bool true`: Safari's Develop menu can inspect this window (for a person, or support, finding why a step failed).
        if #available(macOS 13.3, *), UserDefaults.standard.bool(forKey: "inspect") { view.isInspectable = true }
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
        for s in sockets.values { s.stop() }
        sockets.removeAll()
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
        if op.hasPrefix("ws.") { return wsCall(op, args) } // fire and forget: the page's events come back through _ws
        let box = UncheckedBox(args)
        Task { @MainActor in await self.handle(id: id, op: op, args: box) }
    }

    private func handle(id: Int, op: String, args box: UncheckedBox) async {
        let args = box.value
        switch op {
        case "presence":
            guard let p = presence, let tool = args["tool"] as? String else { return reply(id, ["error": "Touch ID is not set up on this Mac yet."]) }
            let input = args["input"] as? [String: Any] ?? [:]
            switch await p.proofFromAnyThread(tool: tool, input: UncheckedBox(input), summary: args["summary"] as? String) {
            case .success(let header): reply(id, ["header": header])
            case .failure(let f): reply(id, ["error": f.message])
            }
        case "presence.key":
            // the Capsule's key for a Mac server: its public half (SPKI) and the id vyre-core will give it; the pairing carries it, and `presence` above signs with it behind Touch ID
            guard let p = presence, let e = p.keyForServer() else { return reply(id, ["error": "This Mac could not make its key for the server."]) }
            reply(id, ["public_key": e.publicKey, "id": e.id])
        case "identity.public", "identity.sign", "identity.has", "identity.forget":
            guard let id0 = identity else { return reply(id, ["error": "This Mac cannot keep your key."]) }
            switch op {
            case "identity.public":
                guard let pub = id0.publicKey(create: args["create"] as? Bool ?? false) else { return reply(id, ["error": args["create"] as? Bool == true ? "This Mac would not keep your key." : "There is no key on this Mac."]) }
                reply(id, ["publicKey": MacIdentity.b64url(pub)])
            case "identity.sign":
                guard let m = (args["message"] as? String).flatMap(MacIdentity.unb64url), let sig = id0.sign(m) else { return reply(id, ["error": "There is no key on this Mac to sign with."]) }
                reply(id, ["signature": MacIdentity.b64url(sig)])
            case "identity.has": reply(id, ["has": id0.has])
            default:
                guard confirmForget() else { return reply(id, ["error": "Not forgotten. Your key is still on this Mac."]) }
                id0.forget(); reply(id, ["ok": true])
            }
        case "agree.public":
            guard let pt = agreement?.publicPoint(create: args["create"] as? Bool ?? false) else { return reply(id, ["error": "This Mac has no agreement key."]) }
            reply(id, ["publicKey": MacIdentity.b64url(pt)])
        case "agree.agree":
            guard let epk = (args["epk"] as? String).flatMap(MacIdentity.unb64url), let secret = agreement?.agree(epk: epk) else { return reply(id, ["error": "This Mac could not open that."]) }
            reply(id, ["secret": MacIdentity.b64url(secret)])
        case "setup.server":
            makeServer?()
            reply(id, ["ok": true])
        case "enclave.public":
            guard let pt = enclave?.publicPoint(create: args["create"] as? Bool ?? false) else { return reply(id, ["error": "This Mac has no Secure Enclave key."]) }
            reply(id, ["publicKey": MacIdentity.b64url(pt)])
        case "enclave.sign":
            guard let m = (args["message"] as? String).flatMap(MacIdentity.unb64url), let e = enclave else { return reply(id, ["error": "There is no Secure Enclave key on this Mac to sign with."]) }
            // KP-3: the words on the Touch ID sheet are the shell's own, read from the bytes. The page's `prompt` is never shown, and bytes the shell cannot read are not signed.
            guard let said = SignSummary.of(message: m, fields: args["fields"] as? [String: Any], space: args["space"] as? String) else { return reply(id, ["error": "Vyre cannot tell what this would sign, so it did not."]) }
            guard let sig = await e.sign(m, reason: String(said.prefix(300))) else { return reply(id, ["error": "Not approved. Nothing was changed."]) }
            reply(id, ["signature": MacIdentity.b64url(sig)])
        case "notify":
            Notifier.shared.post(title: args["title"] as? String ?? "Vyre", body: args["body"] as? String ?? "")
            reply(id, ["ok": true])
        case "open":
            if let s = args["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
            reply(id, ["ok": true])
        default:
            reply(id, ["error": "Unknown call \(op)."])
        }
    }

    // MARK: The page's WebSockets

    /// Only vyred's own stream routes are opened for the page: /v1/streams/<module>/<name>, with its query (the ticket).
    static func isStreamPath(_ p: String) -> Bool {
        p.range(of: "^/v1/streams/[a-z][a-z0-9-]*/[a-z][a-z0-9-]*(\\?[A-Za-z0-9._~%=&+-]*)?$", options: .regularExpression) != nil
    }

    private func wsCall(_ op: String, _ args: [String: Any]) {
        guard let sid = args["sid"] as? Int else { return }
        switch op {
        case "ws.open":
            guard let path = args["path"] as? String, Self.isStreamPath(path), !socket.isEmpty, sockets[sid] == nil else { return wsEvent(sid, "close", ["code": 1006, "reason": ""]) }
            let ws = BoxSocket(socket: socket, path: path,
                onOpen: { [weak self] in DispatchQueue.main.async { self?.wsEvent(sid, "open", NSNull()) } },
                onMessage: { [weak self] m in
                    DispatchQueue.main.async {
                        switch m {
                        case .text(let t): self?.wsEvent(sid, "text", t)
                        case .binary(let d): self?.wsEvent(sid, "binary", d.base64EncodedString())
                        default: break
                        }
                    }
                },
                onClose: { [weak self] code, reason in DispatchQueue.main.async { self?.sockets[sid] = nil; self?.wsEvent(sid, "close", ["code": code, "reason": reason]) } })
            sockets[sid] = ws
            ws.start()
        case "ws.send":
            if let t = args["text"] as? String { sockets[sid]?.send(.text(t)) }
            else if let b = args["b64"] as? String, let d = Data(base64Encoded: b) { sockets[sid]?.send(.binary(d)) }
        case "ws.close":
            sockets[sid]?.close(code: args["code"] as? Int ?? 1000, reason: args["reason"] as? String ?? "")
        default: break
        }
    }

    private func wsEvent(_ sid: Int, _ kind: String, _ data: Any) {
        run("window.__vyreWS && window.__vyreWS._event(\(sid), \(Self.js(kind)), \(Self.json(["v": data])).v)")
    }

    private func reply(_ id: Int, _ value: [String: Any]) {
        if let e = value["error"] as? String { Self.log("reply \(id): \(e)") }
        run("window.__vyreShell && window.__vyreShell._reply(\(id), \(Self.json(value)))")
    }
    /// One line per failed call, in ~/Library/Logs/Vyre/app.log, so a step that fails says why somewhere a person (or support) can read.
    nonisolated static func log(_ line: String) {
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/Vyre")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent("app.log")
        let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close() } else { try? text.write(toFile: path, atomically: true, encoding: .utf8) }
    }
    private func run(_ script: String) { web?.evaluateJavaScript(script, completionHandler: nil) }

    static func json(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return "null" }
        return s
    }
    /// Sets window.__vyreVersion before the bridge is made.
    static func versionScript(_ version: String) -> String { "window.__vyreVersion = \(js(version));" }
    static func js(_ s: String) -> String { json([s]).dropFirst().dropLast().description }

    // MARK: Navigation and files

    /// The page stays inside vyreapp://; an https link opens in the person's browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Self.scheme || url.scheme == "about" { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// A page's file input: the system's open panel. (A file dragged onto the page reaches it as a drop event with no help from here.)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// Replaces the page's WebSocket for the app's own address (vyreapp://box/...): the stream is opened by the app on vyred's socket (BoxSocket.swift). Any other address
    /// gets the real WebSocket. Binary messages cross as base64.
    static let wsShimSource = """
    (function () {
      if (window.__vyreWS) return;
      var Native = window.WebSocket, socks = {}, next = 1;
      function post(op, args) { window.webkit.messageHandlers.vyre.postMessage({ id: 0, op: op, args: args }); }
      function b64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
      function unb64(s) { var r = atob(s), b = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b.buffer; }
      function VyreWS(url, protocols) {
        var m = /^(?:vyreapp|ws):\\/\\/box(\\/[^#]*)$/.exec(String(url));
        if (!m) return new Native(url, protocols);
        if (!(this instanceof VyreWS)) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
        var sid = next++, self = this, L = {}, queue = Promise.resolve();
        this.url = String(url); this.readyState = 0; this.bufferedAmount = 0; this.extensions = ""; this.protocol = ""; this.binaryType = "blob";
        this.onopen = this.onmessage = this.onerror = this.onclose = null;
        function fire(type, ev) {
          ev.type = type; ev.target = self;
          var h = self["on" + type]; if (h) { try { h.call(self, ev); } catch (e) {} }
          (L[type] || []).slice().forEach(function (f) { try { f.call(self, ev); } catch (e) {} });
        }
        this.addEventListener = function (t, f) { (L[t] = L[t] || []).push(f); };
        this.removeEventListener = function (t, f) { L[t] = (L[t] || []).filter(function (x) { return x !== f; }); };
        this.dispatchEvent = function (e) { fire(e.type, e); return true; };
        this.send = function (d) {
          if (self.readyState !== 1) throw new DOMException("The socket is not open.", "InvalidStateError");
          queue = queue.then(function () {
            if (typeof d === "string") return post("ws.send", { sid: sid, text: d });
            var buf = d instanceof Blob ? d.arrayBuffer() : Promise.resolve(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
            return buf.then(function (b) { post("ws.send", { sid: sid, b64: b64(b) }); });
          });
        };
        this.close = function (code, reason) { if (self.readyState >= 2) return; self.readyState = 2; post("ws.close", { sid: sid, code: code || 1000, reason: reason || "" }); };
        socks[sid] = function (kind, v) {
          if (kind === "open") { self.readyState = 1; fire("open", {}); }
          else if (kind === "text") fire("message", { data: v });
          else if (kind === "binary") { var ab = unb64(v); fire("message", { data: self.binaryType === "arraybuffer" ? ab : new Blob([ab]) }); }
          else if (kind === "close") { self.readyState = 3; delete socks[sid]; if (v.code !== 1000 && v.code !== 1001) fire("error", {}); fire("close", { code: v.code, reason: v.reason, wasClean: v.code === 1000 }); }
        };
        post("ws.open", { sid: sid, path: m[1] });
      }
      VyreWS.CONNECTING = 0; VyreWS.OPEN = 1; VyreWS.CLOSING = 2; VyreWS.CLOSED = 3;
      VyreWS.prototype.CONNECTING = 0; VyreWS.prototype.OPEN = 1; VyreWS.prototype.CLOSING = 2; VyreWS.prototype.CLOSED = 3;
      window.__vyreWS = { _event: function (sid, kind, v) { var f = socks[sid]; if (f) f(kind, v); } };
      window.WebSocket = VyreWS;
    })();
    """

    /// The page the bridge makes: window.__vyreShell.
    static let bridgeSource = """
    (function () {
      if (window.__vyreShell) return;
      var pending = {}, next = 1, commands = [];
      function call(op, args) {
        return new Promise(function (resolve, reject) {
          var id = next++;
          pending[id] = { resolve: resolve, reject: reject };
          window.webkit.messageHandlers.vyre.postMessage({ id: id, op: op, args: args || {} });
        });
      }
      window.__vyreShell = {
        kind: "mac",
        boxless: !!window.__vyreBoxless,
        version: window.__vyreVersion || "",
        presence: function (tool, input, summary) { return call("presence", { tool: tool, input: input, summary: summary }).then(function (r) { return r.header; }); },
        presenceKey: function () { return call("presence.key").then(function (r) { return { public_key: r.public_key, id: r.id }; }); },
        notify: function (title, body) { return call("notify", { title: title, body: body }); },
        open: function (url) { return call("open", { url: url }); },
        identity: {
          public: function (create) { return call("identity.public", { create: !!create }).then(function (r) { return r.publicKey; }); },
          sign: function (message) { return call("identity.sign", { message: message }).then(function (r) { return r.signature; }); },
          has: function () { return call("identity.has").then(function (r) { return r.has; }); },
          forget: function () { return call("identity.forget").then(function () {}); },
          agreePublic: function (create) { return call("agree.public", { create: !!create }).then(function (r) { return r.publicKey; }); },
          agree: function (epk) { return call("agree.agree", { epk: epk }).then(function (r) { return r.secret; }); },
          makeServer: function () { return call("setup.server").then(function () {}); },
          enclavePublic: function (create) { return call("enclave.public", { create: !!create }).then(function (r) { return r.publicKey; }); },
          enclaveSign: function (message, prompt, card) { return call("enclave.sign", { message: message, prompt: prompt, fields: card && card.fields, space: card && card.space }).then(function (r) { return r.signature; }); }
        },
        onCommand: function (fn) { commands.push(fn); return function () { commands = commands.filter(function (f) { return f !== fn; }); }; },
        _reply: function (id, value) { var p = pending[id]; if (!p) return; delete pending[id]; if (value && value.error) p.reject(new Error(value.error)); else p.resolve(value); },
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
    /// Set for a server Mac: the web build's folder inside the app. Requests are answered from it, and nothing goes to a socket.
    var bundleDir: String?
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    func stopAll() { lock.lock(); stopped.removeAll(); lock.unlock() }
    private func isStopped(_ t: WKURLSchemeTask) -> Bool { lock.lock(); defer { lock.unlock() }; return stopped.contains(ObjectIdentifier(t)) }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock() }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        if let dir = bundleDir { return serveBundled(task, dir: dir) }
        guard let url = task.request.url, !socket.isEmpty else { return task.didFailWithError(URLError(.cannotConnectToHost)) }
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?" + q }
        let method = task.request.httpMethod ?? "GET"
        let body = BoxSchemeHandler.body(of: task.request)
        var headers: [String: String] = [:]
        for k in ["x-vyre-presence", "x-vyre-presence-keep", "idempotency-key", "last-event-id"] { if let v = task.request.value(forHTTPHeaderField: k) { headers[k] = v } }
        let accept = task.request.value(forHTTPHeaderField: "Accept") ?? "*/*"
        let stream = accept.contains("text/event-stream")
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
                if gone { return }
                switch result {
                case .success: if sent { task.didFinish() } else { task.didFailWithError(URLError(.badServerResponse)) }
                case .failure: task.didFailWithError(URLError(.cannotConnectToHost))
                }
            }
        }
    }

    /// A server Mac's window: the app's own files from the folder carried inside this app (BundledApp.swift). A call to a box has no vyred here and fails.
    private func serveBundled(_ task: WKURLSchemeTask, dir: String) {
        guard let url = task.request.url, (task.request.httpMethod ?? "GET") == "GET" else { return task.didFailWithError(URLError(.cannotConnectToHost)) }
        let path = url.path.isEmpty ? "/" : url.path
        guard case .file(let file, let mime) = BundledApp.resolve(path: path, in: dir), let data = FileManager.default.contents(atPath: file) else {
            let gone = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(gone); task.didReceive(Data()); task.didFinish()
            return
        }
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"])!
        task.didReceive(ok); task.didReceive(data); task.didFinish()
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
