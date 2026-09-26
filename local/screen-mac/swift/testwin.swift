// testwin: a window that belongs to the test that opened it.
//
// The rules for tests on this Mac: act only on windows the test owns, open them unfocused, and
// never send input anywhere else. This app is that window. It opens without activating (an
// accessory app never takes the menu bar or the keyboard from the person), shows a known set of
// controls, prints one JSON line with its pid and window title, and exits when its stdin closes,
// so a test that dies takes its window with it.
//
//   testwin [--title T] [--x N --y N --w N --h N]
//
// Controls: a text field "Name", a secure field "Password", a button "Press me" that counts its
// presses into the label "Pressed 0", a button "Send", and a text view with a known paragraph.

import Cocoa

var title = "Vyre test window"
var frame = NSRect(x: 120, y: 120, width: 520, height: 360)
let args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    let a = args[i], v = i + 1 < args.count ? args[i + 1] : ""
    switch a {
    case "--title": title = v; i += 1
    case "--x": frame.origin.x = CGFloat(Double(v) ?? 120); i += 1
    case "--y": frame.origin.y = CGFloat(Double(v) ?? 120); i += 1
    case "--w": frame.size.width = CGFloat(Double(v) ?? 520); i += 1
    case "--h": frame.size.height = CGFloat(Double(v) ?? 360); i += 1
    default: break
    }
    i += 1
}

final class Controller: NSObject {
    let label = NSTextField(labelWithString: "Pressed 0")
    var presses = 0
    @objc func press() { presses += 1; label.stringValue = "Pressed \(presses)" }
    @objc func send() { label.stringValue = "Sent" }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let c = Controller()

let win = NSWindow(contentRect: frame, styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: false)
win.title = title
win.isReleasedWhenClosed = false

let stack = NSStackView()
stack.orientation = .vertical
stack.alignment = .leading
stack.spacing = 10
stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

let name = NSTextField(string: "")
name.placeholderString = "Name"
name.setAccessibilityLabel("Name")
let secret = NSSecureTextField(string: "hunter2-test-only")
secret.setAccessibilityLabel("Password")
let pressBtn = NSButton(title: "Press me", target: c, action: #selector(Controller.press))
let sendBtn = NSButton(title: "Send", target: c, action: #selector(Controller.send))
let body = NSTextField(wrappingLabelWithString: "Northwind Bakery opens at seven. Harlow Legal closes at five.")
for v in [name, secret, pressBtn, sendBtn, c.label, body] as [NSView] { stack.addArrangedSubview(v) }
name.widthAnchor.constraint(equalToConstant: 300).isActive = true
secret.widthAnchor.constraint(equalToConstant: 300).isActive = true
win.contentView = stack

// Shown, never activated: the person's keyboard stays where it was.
win.orderFrontRegardless()

setvbuf(stdout, nil, _IOLBF, 0)
let out: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "title": title, "windowNumber": win.windowNumber]
if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }

// Exit when the test goes away.
DispatchQueue.global().async {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    DispatchQueue.main.async { exit(0) }
}
app.run()
