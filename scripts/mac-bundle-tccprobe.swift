// mac-bundle-tccprobe.swift: spike S1's probe (docs/work/capsule-bundle.md), built only in CI.
// It asks TCC, without prompting, what this process may do (Accessibility, Input Monitoring, the
// microphone) and writes the answers as JSON to the path in argv[1]. The workflow builds it twice,
// signed with one certificate, grants the first build's designated requirement in TCC.db, and runs
// the second build: if TCC matches by requirement, the second build is granted too.
import AVFoundation
import ApplicationServices
import Foundation
import IOKit.hid

let stamp = "STAMP"
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/dev/stdout"
let hid: String
switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
case kIOHIDAccessTypeGranted: hid = "granted"
case kIOHIDAccessTypeDenied: hid = "denied"
default: hid = "unknown"
}
let mic: String
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized: mic = "granted"
case .denied: mic = "denied"
case .restricted: mic = "restricted"
default: mic = "unknown"
}
let r: [String: Any] = ["stamp": stamp, "pid": getpid(), "accessibility": AXIsProcessTrusted() ? "granted" : "not granted",
                        "input_monitoring": hid, "microphone": mic]
let d = try! JSONSerialization.data(withJSONObject: r, options: [.sortedKeys])
FileManager.default.createFile(atPath: out, contents: d)
