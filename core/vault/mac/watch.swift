// watch: tells vyred when this Mac sleeps, its screens sleep, the screen locks, or the person
// switches user (ADR 0006, decision 2). It prints one JSON line per signal and nothing else:
//
//   {"signal":"sleep"} {"signal":"screen-sleep"} {"signal":"screen-lock"} {"signal":"resign"}
//
// It waits on the run loop, so it uses no CPU between signals. It exits when stdin closes, so it
// never outlives the vyred that started it.

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func say(_ signal: String) {
    print("{\"signal\":\"\(signal)\"}")
}

let ws = NSWorkspace.shared.notificationCenter
ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in say("sleep") }
ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { _ in say("screen-sleep") }
ws.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { _ in say("resign") }
DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in say("screen-lock") }

// stdin closing means vyred is gone.
let input = FileHandle.standardInput
input.readabilityHandler = { h in
    if h.availableData.isEmpty { exit(0) }
}

print("{\"ready\":true}")
RunLoop.main.run()
