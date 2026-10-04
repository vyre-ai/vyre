// Local notices on iOS: the permission, and a notice shown now whose tap opens a vyre:// link.
// UNUserNotificationCenter only. No APNs registration, no push token, nothing leaves the phone.

import ExpoModulesCore
import UIKit
import UserNotifications

/// Shows a notice as a banner while the app is open, and opens vyre://<route>?notice=1 when it is tapped.
final class VyreNoticeDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = VyreNoticeDelegate()

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    if let route = response.notification.request.content.userInfo["route"] as? String,
       let url = URL(string: "vyre://" + route.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "?notice=1") {
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
    done()
  }
}

public class VyreNotifyModule: Module {
  private func state(_ s: UNNotificationSettings) -> [String: Any] {
    let granted = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional || s.authorizationStatus == .ephemeral
    let status = granted ? "granted" : (s.authorizationStatus == .notDetermined ? "undetermined" : "denied")
    return ["granted": granted, "canAskAgain": s.authorizationStatus == .notDetermined, "status": status]
  }

  public func definition() -> ModuleDefinition {
    Name("VyreNotify")

    OnCreate {
      UNUserNotificationCenter.current().delegate = VyreNoticeDelegate.shared
    }

    AsyncFunction("getPermission") { (promise: Promise) in
      UNUserNotificationCenter.current().getNotificationSettings { promise.resolve(self.state($0)) }
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
        center.getNotificationSettings { promise.resolve(self.state($0)) }
      }
    }

    /// Show a notice now. `route` is an app path such as /u/now. False when permission is not given.
    AsyncFunction("show") { (id: String, title: String, body: String?, route: String?, promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        let s = self.state(settings)
        guard (s["granted"] as? Bool) == true else { promise.resolve(false); return }
        let content = UNMutableNotificationContent()
        content.title = title
        if let body = body { content.body = body }
        content.sound = .default
        if let route = route { content.userInfo = ["route": route] }
        // A one second trigger: a notice with no trigger is not delivered by every iOS version.
        let req = UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
        center.add(req) { err in promise.resolve(err == nil) }
      }
    }
  }
}
