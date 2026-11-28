import UserNotifications

/// Each notification with `mutable-content` from a Mac: its sealed `e` opened on this phone into the session's title
/// and kind; on iOS 16, or when it doesn't open, the fixed words the app kept (app/shared/away.ts). Never the payload's own text (plan §1.3).
class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler done: @escaping (UNNotificationContent) -> Void) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        let kept = Sealed.kept()
        let words = kept?.words ?? [:]
        (content.title, content.body) = ("", words["fallback"] ?? content.body)
        if #available(iOS 17, *), let kept, let e = (request.content.userInfo["e"] as? String).flatMap({ Data(base64Encoded: $0) }),
           let note = try? Sealed.open(e, key: kept.key, device: kept.device) {
            (content.title, content.body) = (note.t, words[note.k] ?? note.k)
            content.threadIdentifier = note.s
        }
        done(content)
    }
}
