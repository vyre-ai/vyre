import UserNotifications

/// Opens the sealed part of a Vyre push (ADR 0015 section 4) into the notification's userInfo,
/// so a tap deep-links to `/needs/<id>` or `/threads/<id>`. The visible text stays the fixed
/// sentence the box sent: nothing from the sealed part is shown on the lock screen.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content); return
        }
        content = mutable
        var info = mutable.userInfo
        if let sealed = info["sealed"] as? String, let key = PushKeyStore.load(), let opened = PushSeal.open(sealed, key: key) {
            info["path"] = opened.path
            if let tag = opened.tag { mutable.threadIdentifier = tag }
        }
        info["sealed"] = nil
        mutable.userInfo = info
        contentHandler(mutable)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let content {
            content.userInfo["sealed"] = nil
            handler(content)
        }
    }
}
