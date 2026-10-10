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
    // a button (Approve, Deny) names its own route in userInfo["actions"]; a plain tap uses the notice's route. Either opens the app, where the card's own path answers.
    let info = response.notification.request.content.userInfo
    let routes = info["actions"] as? [String: String] ?? [:]
    let chosen = routes[response.actionIdentifier] ?? info["route"] as? String
    if let route = chosen {
      let path = route.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      if let url = URL(string: "vyre://" + path + (path.contains("?") ? "&" : "?") + "notice=1") {
        DispatchQueue.main.async { UIApplication.shared.open(url) }
      }
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
    AsyncFunction("show") { (id: String, title: String, body: String?, route: String?, actions: [[String: String]]?, promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        let s = self.state(settings)
        guard (s["granted"] as? Bool) == true else { promise.resolve(false); return }
        let content = UNMutableNotificationContent()
        content.title = title
        if let body = body { content.body = body }
        content.sound = .default
        var info: [String: Any] = [:]
        if let route = route { info["route"] = route }
        // A one second trigger: a notice with no trigger is not delivered by every iOS version.
        let send = {
          content.userInfo = info
          let req = UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
          center.add(req) { err in promise.resolve(err == nil) }
        }
        // Approve and Deny as buttons: foreground actions, so the app opens and the card's own path (Face ID for a yes) answers. The category is registered before the notice is added.
        var routes: [String: String] = [:]
        let buttons = (actions ?? []).prefix(2).compactMap { a -> UNNotificationAction? in
          guard let aid = a["id"], let label = a["label"], let to = a["route"] else { return nil }
          routes[aid] = to
          return UNNotificationAction(identifier: aid, title: label, options: [.foreground])
        }
        if buttons.isEmpty { send(); return }
        let cat = "needs-you-" + buttons.map { $0.identifier }.joined(separator: "-")
        info["actions"] = routes
        content.categoryIdentifier = cat
        center.getNotificationCategories { have in
          if !have.contains(where: { $0.identifier == cat }) {
            center.setNotificationCategories(have.union([UNNotificationCategory(identifier: cat, actions: buttons, intentIdentifiers: [], options: [])]))
          }
          send()
        }
      }
    }
  }
}
