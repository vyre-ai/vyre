// type: fills a login into the app in front (ADR 0006, section 6, the Capsule). vyred starts it,
// writes one JSON line on stdin and reads one JSON line back. Values arrive on stdin only.
//
//   in:  {"bundle":"com.apple.Safari","pid":123,"browser":"safari"|"chrome"|null,
//         "hosts":["https://example.com"],"username":"...","password":"..."}
//   out: {"ok":true,"filled":["username","password"],"via":"ax"|"keys"}
//        {"ok":false,"code":"not_trusted"|"app_changed"|"wrong_origin"|"no_url"|"no_field"|"bad_input","message":"..."}
//
// Checks before anything is typed, and again before each field:
//   - Accessibility is granted (AXIsProcessTrusted), or it stops with a readable error.
//   - The frontmost app is still the one the person picked (bundle id and pid).
//   - In a browser, the front tab's URL has exactly one of the login's origins (scheme, host, port).
//   - The focused element belongs to that app.
// It sets AXValue on the focused field, and falls back to typing unicode key events sent to that
// app's pid only. Username, Tab, password. It never presses Return: submitting is the person's.

import AppKit
import ApplicationServices
import Foundation

func reply(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o) {
        FileHandle.standardOutput.write(d)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func fail(_ code: String, _ message: String) -> Never {
    reply(["ok": false, "code": code, "message": message])
    exit(0)
}

guard let line = readLine(strippingNewline: true),
      let data = line.data(using: .utf8),
      let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    fail("bad_input", "no request on stdin")
}

let bundle = req["bundle"] as? String ?? ""
let pid = (req["pid"] as? NSNumber)?.int32Value ?? -1
let browser = req["browser"] as? String
let hosts = (req["hosts"] as? [String]) ?? []
let username = req["username"] as? String ?? ""
let password = req["password"] as? String ?? ""

if bundle.isEmpty || bundle.range(of: "^[A-Za-z0-9.-]{1,200}$", options: .regularExpression) == nil || pid <= 0 {
    fail("bad_input", "the app is not named")
}

if !AXIsProcessTrusted() {
    fail("not_trusted", "Vyre needs Accessibility to fill apps: System Settings, Privacy & Security, Accessibility")
}

func frontIsTarget() -> Bool {
    guard let f = NSWorkspace.shared.frontmostApplication else { return false }
    return f.bundleIdentifier == bundle && f.processIdentifier == pid
}

if !frontIsTarget() { fail("app_changed", "the app in front changed; nothing was filled") }

/// scheme://host[:port], the way a browser computes an origin. Nil for anything but http(s).
func origin(_ s: String) -> String? {
    guard let u = URLComponents(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = u.host?.lowercased(), !host.isEmpty else { return nil }
    var o = "\(scheme)://\(host)"
    if let p = u.port, !((scheme == "https" && p == 443) || (scheme == "http" && p == 80)) { o += ":\(p)" }
    return o
}

if let b = browser {
    let source: String
    switch b {
    case "safari": source = "tell application id \"\(bundle)\" to get URL of front document"
    case "chrome": source = "tell application id \"\(bundle)\" to get URL of active tab of front window"
    default: fail("bad_input", "unknown browser")
    }
    var err: NSDictionary?
    guard let script = NSAppleScript(source: source), let url = script.executeAndReturnError(&err).stringValue else {
        fail("no_url", "could not read the page address from the browser; allow Vyre under Automation in System Settings")
    }
    guard let o = origin(url), hosts.compactMap({ origin($0) }).contains(o) else {
        fail("wrong_origin", "this login is not for the page in front")
    }
    if !frontIsTarget() { fail("app_changed", "the app in front changed; nothing was filled") }
}

let system = AXUIElementCreateSystemWide()

func focused() -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &v) == .success, let e = v,
          CFGetTypeID(e) == AXUIElementGetTypeID() else { return nil }
    let el = e as! AXUIElement
    var p: pid_t = 0
    guard AXUIElementGetPid(el, &p) == .success, p == pid else { return nil }
    return el
}

func isSecure(_ el: AXUIElement) -> Bool {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &v) == .success else { return false }
    return (v as? String) == "AXSecureTextField"
}

var via = "ax"

func typeText(_ s: String) {
    let units = Array(s.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        for down in [true, false] {
            if let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) {
                e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                e.postToPid(pid)
            }
        }
        i += 16
        usleep(8_000)
    }
}

func pressTab() {
    for down in [true, false] {
        if let e = CGEvent(keyboardEventSource: nil, virtualKey: 48, keyDown: down) { e.postToPid(pid) }
    }
}

func put(_ value: String) -> Bool {
    guard frontIsTarget(), let el = focused() else { return false }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
       AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef) == .success {
        return true
    }
    via = "keys"
    typeText(value)
    return true
}

var filled: [String] = []
guard let first = focused() else { fail("no_field", "click the field to fill first") }

if !username.isEmpty && !isSecure(first) {
    if !put(username) { fail("app_changed", "the app in front changed; nothing was filled") }
    filled.append("username")
    if !password.isEmpty {
        guard frontIsTarget() else { fail("app_changed", "the app in front changed after the username") }
        pressTab()
        usleep(120_000)
        if !put(password) { fail("app_changed", "the app in front changed after the username") }
        filled.append("password")
    }
} else if !password.isEmpty {
    if !put(password) { fail("app_changed", "the app in front changed; nothing was filled") }
    filled.append("password")
}

reply(["ok": true, "filled": filled, "via": via])
exit(0)
