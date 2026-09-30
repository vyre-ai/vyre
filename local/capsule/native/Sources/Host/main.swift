// The Capsule's entry point (the app build only; tests have their own).

import AppKit

// The installer's one-time code arrives on fd 3. Read it before anything else can open a
// descriptor of its own (Host/CoreEnroll.swift).
CoreEnroll.handoff = CoreEnroll.readHandoff()

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = CapsuleApp()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
