// overlay: what the person sees while Vyre drives their Mac, and how they stop it.
//
// Computer use is otherwise invisible. A window changes and nobody can tell whether Vyre did it,
// where it aimed when it got something wrong, or how to make it stop. This helper answers all
// three, and does nothing else:
//
//   a ring       where each act landed, green when the act was verified and red when it was not.
//                Not a pointer, a trace. It fades in half a second.
//   a pill       "Vyre is controlling <App> · Esc to stop", top centre, while a session is live.
//   stop keys    Escape, or Control pressed twice within 350 ms with nothing between, heard only
//                while the pill shows. A stop prints {"stop":true} and ends the helper.
//
// Protocol: NDJSON on stdin, one object a line.
//   {"controlling":{"app":"Notes","x":840,"y":512}}   start or extend the session (x, y optional:
//                                                       they pick the screen the pill goes on)
//   {"ring":{"x":840,"y":512,"ok":true}}              a ring at that point
//   {"done":true}                                     the session is over: hide and exit
// On stdout: {"ready":true,"keys":<can the stop keys be heard>} once, and {"stop":true}.
// Points are accessibility coordinates: global, top-left origin, in points.
//
// Light by construction. Nothing runs while idle: stdin is a readability handler, the keys are
// event monitors, the linger is one deferred block. The only timer is the ring's, and it exists
// only for the half second a ring is drawn. The helper exits 8 s after the last message, so
// between sessions it does not exist at all. It exits when stdin closes, too, so the process
// that started it cannot leave a pill behind by dying.
//
// It never takes focus: an accessory app, non-activating panels that cannot become key, and
// windows that ignore the mouse, so it can never intercept the click it is illustrating.
//
//   overlay [--linger S] [--ring-ms N]    run
//   overlay --selftest                     check the pure logic (stop keys, geometry, protocol)
//   overlay --preflight                    which grants this process has, without asking for any
//
// The classes below take their dependencies in their initialisers so they can move into the
// native Capsule shell unchanged; the bottom of the file is the standalone entry point.

import Cocoa
import ApplicationServices

// ---------------------------------------------------------------- pure logic

/// Escape, or a double Control, from the person's own keyboard.
///
/// Kept free of AppKit so it can be tested without a real keystroke: a test that pressed keys
/// would be sending system-wide input on a Mac someone is using.
struct StopKeys {
    static let escape: UInt16 = 53
    /// The mark the accessibility helper stamps on every keystroke it posts. Those are Vyre's own
    /// keys: an agent sending Escape to its target must not stop itself, and a typed word must
    /// not count as "a key between" the person's two Controls.
    static let vyreMark: Int64 = 0x5659_5245

    enum Input { case key(UInt16), flags(control: Bool, others: Bool) }

    let window: TimeInterval
    private var firstPress: TimeInterval?
    private var controlDown = false

    init(window: TimeInterval = 0.35) { self.window = window }

    /// Feed one event; true means stop now.
    mutating func feed(_ input: Input, at t: TimeInterval, synthetic: Bool = false) -> Bool {
        if synthetic { return false }
        switch input {
        case .key(let code):
            // Any key breaks a double Control, so Control-C twice is never a stop.
            firstPress = nil
            return code == StopKeys.escape
        case .flags(let control, let others):
            if others {
                // Control with Shift or Command is a shortcut, not half of a stop.
                firstPress = nil
                controlDown = control
                return false
            }
            if control && !controlDown {
                controlDown = true
                if let f = firstPress, t - f <= window { firstPress = nil; return true }
                firstPress = t
                return false
            }
            if !control { controlDown = false }
            return false
        }
    }
}

enum Geometry {
    /// Accessibility points are global with the origin at the TOP-left of the primary screen and
    /// y growing down; AppKit's are global with the origin at the BOTTOM-left of the primary
    /// screen and y growing up. Both are one space across every display, so one flip against the
    /// primary screen's height converts a point on any display. The primary screen is
    /// NSScreen.screens[0], the one with the menu bar, never NSScreen.main, which is whichever
    /// screen has the key window.
    static func cocoaPoint(_ ax: CGPoint, primaryHeight: CGFloat) -> CGPoint {
        CGPoint(x: ax.x, y: primaryHeight - ax.y)
    }

    /// Which screen a point is on, by frame, or nil when it is on none (between displays).
    static func screenIndex(containing p: CGPoint, frames: [CGRect]) -> Int? {
        frames.firstIndex { p.x >= $0.minX && p.x < $0.maxX && p.y > $0.minY && p.y <= $0.maxY }
    }

    /// The pill's frame: centred at the top of the visible area, below the menu bar.
    static func pillFrame(size: CGSize, visible: CGRect, margin: CGFloat = 8) -> CGRect {
        CGRect(x: (visible.midX - size.width / 2).rounded(), y: (visible.maxY - size.height - margin).rounded(),
               width: size.width, height: size.height)
    }

    static func ringFrame(center c: CGPoint, size: CGFloat) -> CGRect {
        CGRect(x: c.x - size / 2, y: c.y - size / 2, width: size, height: size)
    }
}

enum Message: Equatable {
    case ring(x: Double, y: Double, ok: Bool)
    case controlling(app: String, x: Double?, y: Double?)
    case done

    /// One protocol line, or nil for anything malformed. A bad line is dropped, never guessed at.
    static func parse(_ line: String) -> Message? {
        guard let d = line.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        func n(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
        if let r = o["ring"] as? [String: Any], let x = n(r["x"]), let y = n(r["y"]) {
            return .ring(x: x, y: y, ok: (r["ok"] as? Bool) == true)
        }
        if let c = o["controlling"] as? [String: Any], let app = c["app"] as? String {
            return .controlling(app: String(app.prefix(60)), x: n(c["x"]), y: n(c["y"]))
        }
        if (o["done"] as? Bool) == true { return .done }
        return nil
    }
}

/// The words on the pill. The app name is cut short so a long one cannot push the stop hint off.
func pillText(_ app: String) -> String {
    let name = app.count > 32 ? String(app.prefix(32)) + "…" : app
    return "Vyre is controlling \(name) · Esc to stop"
}

// ---------------------------------------------------------------- views and panels

/// A panel that is shown and never focused: it cannot become key or main, and it ignores the
/// mouse, so it can never take the keyboard or a click from the app under it.
final class QuietPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(frame: CGRect, level: NSWindow.Level) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        ignoresMouseEvents = true
        // An accessory app is never active, and a panel that hides on deactivation would never show.
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        self.level = level
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    }
}

final class RingView: NSView {
    var progress: CGFloat = 0
    var ok = true

    override func draw(_ dirty: NSRect) {
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        let color = ok ? NSColor(calibratedRed: 0.42, green: 0.80, blue: 0.66, alpha: 1)
                       : NSColor(calibratedRed: 0.93, green: 0.36, blue: 0.32, alpha: 1)
        // Two rings a beat apart read as a pulse rather than a blob, and stay legible over both a
        // white document and a dark terminal.
        for (i, delay) in [CGFloat(0), 0.28].enumerated() {
            let p = max(0, min(1, (progress - delay) / (1 - delay)))
            if p <= 0 { continue }
            let r = 8 + p * 44
            let path = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            path.lineWidth = 3 - p * 1.5
            color.withAlphaComponent((1 - p) * (i == 0 ? 0.95 : 0.55)).setStroke()
            path.stroke()
        }
        // A solid centre so the point of action is unambiguous even mid-fade.
        let dot = 4 - progress * 2
        if dot > 0 {
            color.withAlphaComponent(1 - progress).setFill()
            NSBezierPath(ovalIn: NSRect(x: c.x - dot, y: c.y - dot, width: dot * 2, height: dot * 2)).fill()
        }
    }
}

/// Draws one ring at a time. A new ring restarts the animation where the new act landed.
final class RingPresenter {
    private let size: CGFloat = 120
    private let duration: TimeInterval
    private let screens: () -> [NSScreen]
    private lazy var panel = QuietPanel(frame: CGRect(x: 0, y: 0, width: size, height: size), level: .screenSaver)
    private lazy var view = RingView(frame: CGRect(x: 0, y: 0, width: size, height: size))
    private var timer: Timer?
    private var start = Date()
    var onIdle: (() -> Void)?
    var animating: Bool { timer != nil }

    init(duration: TimeInterval, screens: @escaping () -> [NSScreen] = { NSScreen.screens }) {
        self.duration = duration
        self.screens = screens
    }

    func show(ax: CGPoint, ok: Bool) {
        guard let primary = screens().first else { return }
        let c = Geometry.cocoaPoint(ax, primaryHeight: primary.frame.height)
        if panel.contentView !== view { panel.contentView = view }
        panel.setFrame(Geometry.ringFrame(center: c, size: size), display: false)
        view.ok = ok
        view.progress = 0
        view.needsDisplay = true
        panel.orderFrontRegardless()
        start = Date()
        timer?.invalidate()
        // The only timer in the helper, alive for the length of one ring.
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        let p = CGFloat(Date().timeIntervalSince(start) / duration)
        if p >= 1 {
            timer?.invalidate(); timer = nil
            panel.orderOut(nil)
            onIdle?()
            return
        }
        view.progress = p
        view.needsDisplay = true
    }
}

/// The pill. A real material and the system font, so it reads as part of macOS rather than as
/// something drawn over it.
final class Indicator {
    private let screens: () -> [NSScreen]
    private var panel: QuietPanel?
    private let label = NSTextField(labelWithString: "")
    private(set) var showing = false

    init(screens: @escaping () -> [NSScreen] = { NSScreen.screens }) { self.screens = screens }

    func show(app: String, near ax: CGPoint?) {
        let all = screens()
        guard let primary = all.first else { return }
        var screen = primary
        if let p = ax {
            let c = Geometry.cocoaPoint(p, primaryHeight: primary.frame.height)
            if let i = Geometry.screenIndex(containing: c, frames: all.map { $0.frame }) { screen = all[i] }
        }
        label.stringValue = pillText(app)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .labelColor
        label.sizeToFit()
        let h: CGFloat = 28, dot: CGFloat = 8, pad: CGFloat = 12, gap: CGFloat = 7
        let size = CGSize(width: (pad + dot + gap + label.frame.width + pad).rounded(.up), height: h)
        let frame = Geometry.pillFrame(size: size, visible: screen.visibleFrame)

        let p = panel ?? QuietPanel(frame: frame, level: .statusBar)
        panel = p
        p.appearance = NSAppearance(named: .darkAqua)
        p.hasShadow = true
        let fx = NSVisualEffectView(frame: CGRect(origin: .zero, size: size))
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        // A mask image rounds the material itself; rounding a layer on top of it leaves square
        // vibrancy showing at the corners.
        fx.maskImage = NSImage(size: size, flipped: false) { r in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: r, xRadius: h / 2, yRadius: h / 2).fill()
            return true
        }
        let d = NSView(frame: CGRect(x: pad, y: (h - dot) / 2, width: dot, height: dot))
        d.wantsLayer = true
        d.layer?.backgroundColor = NSColor.systemGreen.cgColor
        d.layer?.cornerRadius = dot / 2
        label.frame.origin = CGPoint(x: pad + dot + gap, y: ((h - label.frame.height) / 2).rounded())
        fx.addSubview(d)
        fx.addSubview(label)
        fx.setAccessibilityLabel(label.stringValue)
        p.contentView = fx
        p.setFrame(frame, display: true)
        p.orderFrontRegardless()
        showing = true
    }

    func hide() {
        panel?.orderOut(nil)
        showing = false
    }
}

/// Hears the stop keys, and only while it is started. A listen-only global monitor: it sees
/// events on their way to other apps and can neither change nor swallow them. It needs the
/// Accessibility grant, which never raises a prompt from here; without it, it hears nothing, and
/// `canHear` says so up front.
final class StopListener {
    private var keys = StopKeys()
    private var monitors: [Any] = []
    private let onStop: () -> Void
    static var canHear: Bool { AXIsProcessTrusted() }

    init(onStop: @escaping () -> Void) { self.onStop = onStop }

    func start() {
        guard monitors.isEmpty else { return }
        keys = StopKeys()
        let handle: (NSEvent) -> Void = { [weak self] e in
            guard let self else { return }
            let synthetic = e.cgEvent?.getIntegerValueField(.eventSourceUserData) == StopKeys.vyreMark
            let input: StopKeys.Input
            if e.type == .keyDown { input = .key(e.keyCode) }
            else {
                let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
                input = .flags(control: f.contains(.control), others: !f.intersection([.shift, .command, .option, .function]).isEmpty)
            }
            if self.keys.feed(input, at: e.timestamp, synthetic: synthetic) { self.onStop() }
        }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .flagsChanged], handler: handle) { monitors.append(m) }
    }

    func stop() {
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
    }
}

/// One control session: the pill, the stop keys and the linger, driven by protocol messages.
final class Session {
    private let rings: RingPresenter
    private let indicator: Indicator
    private var listener: StopListener!
    private let linger: TimeInterval
    private let say: ([String: Any]) -> Void
    private let quit: () -> Void
    private var ending: DispatchWorkItem?
    private var stopped = false

    init(rings: RingPresenter, indicator: Indicator, linger: TimeInterval,
         say: @escaping ([String: Any]) -> Void, quit: @escaping () -> Void) {
        self.rings = rings; self.indicator = indicator; self.linger = linger; self.say = say; self.quit = quit
        self.listener = StopListener(onStop: { [weak self] in self?.stop() })
    }

    func handle(_ m: Message) {
        if stopped { return }
        switch m {
        case .controlling(let app, let x, let y):
            indicator.show(app: app, near: x.flatMap { x in y.map { CGPoint(x: x, y: $0) } })
            listener.start()
            extend()
        case .ring(let x, let y, let ok):
            rings.show(ax: CGPoint(x: x, y: y), ok: ok)
            extend()
        case .done:
            end()
        }
    }

    /// The session lasts until `linger` after the last message. One deferred block, replaced on
    /// every message; no timer ticks while the pill sits there.
    private func extend() {
        ending?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.end() }
        ending = w
        DispatchQueue.main.asyncAfter(deadline: .now() + linger, execute: w)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        say(["stop": true])
        end()
    }

    func end() {
        ending?.cancel()
        listener.stop()
        indicator.hide()
        // A ring in flight finishes its half second, so the last act is still shown.
        if rings.animating { rings.onIdle = { [weak self] in self?.quit() } } else { quit() }
    }
}

// ---------------------------------------------------------------- self-test

func selftest() -> Int32 {
    var passed = 0, failed: [String] = []
    func check(_ ok: Bool, _ what: String) { if ok { passed += 1 } else { failed.append(what) } }

    // Stop keys.
    var k = StopKeys()
    check(k.feed(.key(53), at: 0), "escape stops")
    k = StopKeys()
    check(!k.feed(.key(53), at: 0, synthetic: true), "Vyre's own escape does not stop")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: false), at: 1.00)
    _ = k.feed(.flags(control: false, others: false), at: 1.08)
    check(k.feed(.flags(control: true, others: false), at: 1.30), "control twice within 350 ms stops")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: false), at: 1.00)
    _ = k.feed(.flags(control: false, others: false), at: 1.10)
    check(!k.feed(.flags(control: true, others: false), at: 1.40), "control twice 400 ms apart does not stop")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: false), at: 1.00)
    _ = k.feed(.key(8), at: 1.05)                                  // Control-C
    _ = k.feed(.flags(control: false, others: false), at: 1.10)
    check(!k.feed(.flags(control: true, others: false), at: 1.20), "a key between the controls breaks it")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: false), at: 1.00)
    _ = k.feed(.flags(control: false, others: false), at: 1.05)
    _ = k.feed(.key(0), at: 1.10, synthetic: true)                 // Vyre typing meanwhile
    check(k.feed(.flags(control: true, others: false), at: 1.20), "Vyre's own keys do not break the person's double control")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: true), at: 1.00)      // Control-Shift
    _ = k.feed(.flags(control: false, others: false), at: 1.05)
    check(!k.feed(.flags(control: true, others: false), at: 1.20) , "control with another modifier is not half a stop")
    k = StopKeys()
    _ = k.feed(.flags(control: true, others: false), at: 1.00)
    check(!k.feed(.flags(control: true, others: false), at: 1.10), "control held down is one press, not two")
    k = StopKeys()
    check(!k.feed(.key(0), at: 0), "an ordinary key does not stop")
    _ = k.feed(.flags(control: true, others: false), at: 5.0)
    _ = k.feed(.flags(control: false, others: false), at: 5.1)
    _ = k.feed(.flags(control: true, others: false), at: 5.2)      // a stop
    _ = k.feed(.flags(control: false, others: false), at: 5.25)
    check(!k.feed(.flags(control: true, others: false), at: 5.3), "the press that stopped does not start the next pair")

    // Geometry: a primary 1440x900 display and a second 1920x1080 display above it, to the right.
    let primary = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let upper = CGRect(x: 1440, y: 900, width: 1920, height: 1080)
    check(Geometry.cocoaPoint(CGPoint(x: 100, y: 0), primaryHeight: 900) == CGPoint(x: 100, y: 900), "top of the primary is its max y")
    check(Geometry.cocoaPoint(CGPoint(x: 720, y: 450), primaryHeight: 900) == CGPoint(x: 720, y: 450), "the primary's centre stays put")
    let up = Geometry.cocoaPoint(CGPoint(x: 2000, y: -500), primaryHeight: 900)   // above the primary in AX
    check(up == CGPoint(x: 2000, y: 1400), "a point on a display above maps above the primary")
    check(Geometry.screenIndex(containing: up, frames: [primary, upper]) == 1, "and lands on that display")
    check(Geometry.screenIndex(containing: Geometry.cocoaPoint(CGPoint(x: 10, y: 10), primaryHeight: 900), frames: [primary, upper]) == 0, "a point near the top left is on the primary")
    let below = Geometry.cocoaPoint(CGPoint(x: -300, y: 1000), primaryHeight: 900)  // a display below, to the left
    check(below == CGPoint(x: -300, y: -100), "a point on a display below maps below zero")
    check(Geometry.screenIndex(containing: below, frames: [primary, upper]) == nil, "and is on no known display")
    let pill = Geometry.pillFrame(size: CGSize(width: 300, height: 28), visible: CGRect(x: 0, y: 0, width: 1440, height: 875))
    check(pill == CGRect(x: 570, y: 839, width: 300, height: 28), "the pill sits top centre below the menu bar")
    check(Geometry.ringFrame(center: CGPoint(x: 100, y: 100), size: 120) == CGRect(x: 40, y: 40, width: 120, height: 120), "the ring is centred on the point")

    // Protocol.
    check(Message.parse(#"{"ring":{"x":10,"y":20.5,"ok":true}}"#) == .ring(x: 10, y: 20.5, ok: true), "ring parses")
    check(Message.parse(#"{"ring":{"x":10,"y":20}}"#) == .ring(x: 10, y: 20, ok: false), "a ring without ok is a miss")
    check(Message.parse(#"{"controlling":{"app":"Notes"}}"#) == .controlling(app: "Notes", x: nil, y: nil), "controlling parses")
    check(Message.parse(#"{"controlling":{"app":"Notes","x":1,"y":2}}"#) == .controlling(app: "Notes", x: 1, y: 2), "controlling with a point parses")
    check(Message.parse(#"{"done":true}"#) == .done, "done parses")
    check(Message.parse("not json") == nil && Message.parse(#"{"ring":{"x":"a"}}"#) == nil && Message.parse("{}") == nil, "junk is dropped")
    check(pillText("Notes") == "Vyre is controlling Notes · Esc to stop", "the pill says who and how to stop")
    check(pillText(String(repeating: "x", count: 50)).hasSuffix("… · Esc to stop"), "a long name keeps the stop hint")

    let out: [String: Any] = failed.isEmpty ? ["selftest": "ok", "passed": passed] : ["selftest": "failed", "passed": passed, "failed": failed]
    if let d = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) { print(s) }
    return failed.isEmpty ? 0 : 1
}

// ---------------------------------------------------------------- entry point

setvbuf(stdout, nil, _IOLBF, 0)
let argv = Array(CommandLine.arguments.dropFirst())
func arg(_ name: String) -> Double? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return Double(argv[i + 1])
}
func say(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

if argv.contains("--selftest") { exit(selftest()) }
if argv.contains("--preflight") {
    // Preflight only: neither call can raise a permission prompt.
    // The primary display's frame and visible frame (AppKit points) ride along, so a test can
    // place its own window where the pill will be drawn.
    var o: [String: Any] = ["screen": CGPreflightScreenCaptureAccess(), "keys": AXIsProcessTrusted()]
    if let p = NSScreen.screens.first {
        let r = { (f: CGRect) in ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height] }
        o["primary"] = r(p.frame); o["visible"] = r(p.visibleFrame)
    }
    say(o)
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar, never the key app

let session = Session(
    rings: RingPresenter(duration: max(0.1, (arg("--ring-ms") ?? 500) / 1000)),
    indicator: Indicator(),
    linger: max(0.2, arg("--linger") ?? 8),
    say: say,
    quit: { exit(0) })

var pending = Data()
FileHandle.standardInput.readabilityHandler = { h in
    let chunk = h.availableData
    if chunk.isEmpty {
        // stdin closed: whoever started this is gone, and so is the session.
        h.readabilityHandler = nil
        DispatchQueue.main.async { exit(0) }
        return
    }
    pending.append(chunk)
    while let nl = pending.firstIndex(of: 0x0A) {
        let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
        pending.removeSubrange(pending.startIndex...nl)
        if let m = Message.parse(line) { DispatchQueue.main.async { session.handle(m) } }
    }
}

say(["ready": true, "keys": StopListener.canHear])
app.run()
