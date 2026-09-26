import Foundation
import Observation
import UIKit
import UserNotifications

/// Native push (ADR 0018 section 4): register with APNs, then `push.subscribe` with the token and
/// a fresh 32-byte key the box seals each push's `{path, tag, at}` under. A box without the push
/// update answers no_such_tool or bad_input (or denied, before tailnet callers are allowed), and
/// the app says so instead of failing.
@MainActor
@Observable
final class PushClient {
    static let missing = "Notifications need the box's push update."

    private(set) var status: String?
    private(set) var device: String?
    @ObservationIgnored private var pending: CheckedContinuation<Data, Error>?

    nonisolated init() {
        device = UserDefaults.standard.string(forKey: "push-device")
    }

    var enabled: Bool { device != nil }

    /// Ask for permission, register with APNs, then subscribe on the box.
    func enable(client: VyreClient?) async {
        guard let client else { return }
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else { status = "Notifications are off for Vyre in the phone's Settings."; return }
            let token = try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
                pending = c
                UIApplication.shared.registerForRemoteNotifications()
            }
            try await subscribe(client: client, token: token)
        } catch let e as VyreError where e.isMissingFeature || e.code == "denied" {
            status = PushClient.missing
        } catch {
            status = (error as? LocalizedError)?.errorDescription ?? "Could not register for notifications on this phone."
        }
    }

    func registered(token: Data) { pending?.resume(returning: token); pending = nil }
    func failed(_ error: Error) { pending?.resume(throwing: error); pending = nil }

    static func input(token: Data, key: Data, bundle: String, sandbox: Bool) -> JSON {
        ["transport": "apns", "token": .string(token.map { String(format: "%02x", $0) }.joined()), "key": .string(key.base64URL),
         "bundle": .string(bundle), "env": sandbox ? "sandbox" : "production"]
    }

    func subscribe(client: VyreClient, token: Data) async throws {
        let key = try PushKeyStore.make()
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        let out = try await client.call("push.subscribe", PushClient.input(token: token, key: key, bundle: Bundle.main.bundleIdentifier ?? "sh.vyre.app", sandbox: sandbox))
        device = out["device"].string
        UserDefaults.standard.set(device, forKey: "push-device")
        status = nil
    }

    func unregister(client: VyreClient?) async {
        if let client, let device { _ = try? await client.call("push.unsubscribe", ["device": .string(device)]) }
        device = nil
        UserDefaults.standard.removeObject(forKey: "push-device")
        PushKeyStore.delete()
        UIApplication.shared.unregisterForRemoteNotifications()
    }
}

/// APNs callbacks and notification taps.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static var model: AppModel?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { AppDelegate.model?.push.registered(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { AppDelegate.model?.push.failed(error) }
    }

    /// A tap: the service extension put the opened path in userInfo.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let path = response.notification.request.content.userInfo["path"] as? String
        await MainActor.run {
            if let path, let r = Route(path: path) { AppDelegate.model?.open(r) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}
