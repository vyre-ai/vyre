// The Capsule's entry point (the app build only; tests have their own).

import AppKit

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = CapsuleApp()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
