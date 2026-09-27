// ContactsProvider: people from Contacts, always under "People".
//
// macOS asks the user once, in a dialog. The Capsule never raises that dialog from typing: it
// reads CNContactStore only when access is already granted. Until it has been asked, a query that
// could be a person's name shows one row, "Show contacts here", and the dialog comes only when the
// user picks that row: its action calls `requestAccess`, which the app wires to
// host.request(.contacts, reason:) (the Capsule's own reason first, and no dialog in a test).
// Denied or restricted: nothing at all, no nagging row.
//
// The section is always People: a gallery gap had CONTACTS in one search and PEOPLE in another.
//
// The store is behind ContactSource so tests never enumerate real contacts; SystemContacts is the
// real one. Nothing about a contact is kept past the query, and nothing is logged.

import AppKit
import Contacts
import Foundation

public struct Person: Sendable, Equatable {
    public var id: String
    public var name: String
    public var org: String
    public var emails: [String]
    public var phones: [String]
    public init(id: String, name: String, org: String = "", emails: [String] = [], phones: [String] = []) {
        self.id = id; self.name = name; self.org = org; self.emails = emails; self.phones = phones
    }
}

public protocol ContactSource: Sendable {
    /// Read without asking: never raises a dialog.
    func status() -> PermissionState
    func search(_ q: String, limit: Int) -> [Person]
}

public final class SystemContacts: ContactSource, @unchecked Sendable {
    let store = CNContactStore()
    static let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    ]
    public init() {}

    public func status() -> PermissionState {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notAsked
        default: return .granted   // limited (raw 4): the user chose some contacts; reading those is allowed
        }
    }

    public func search(_ q: String, limit: Int) -> [Person] {
        guard status() == .granted else { return [] }
        let query = q.trimmingCharacters(in: .whitespaces)
        if query.isEmpty { return [] }
        var seen = Set<String>(), out: [Person] = []
        var found = (try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: Self.keys)) ?? []
        // An email match is cheap only as an exact address: Contacts indexes it that way.
        if query.contains("@") && query.contains(".") {
            found += (try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: query), keysToFetch: Self.keys)) ?? []
        }
        for c in found where seen.insert(c.identifier).inserted {
            let name = CNContactFormatter.string(from: c, style: .fullName) ?? ""
            out.append(Person(id: c.identifier, name: name.isEmpty ? c.organizationName : name, org: c.organizationName,
                              emails: c.emailAddresses.map { $0.value as String }, phones: c.phoneNumbers.map { $0.value.stringValue }))
            if out.count >= limit { break }
        }
        return out
    }

    /// A contact's thumbnail, only if access is already granted. Never asks.
    public func thumbnail(_ id: String) -> Data? {
        guard status() == .granted else { return nil }
        return (try? store.unifiedContact(withIdentifier: id, keysToFetch: [CNContactThumbnailImageDataKey as CNKeyDescriptor]))?.thumbnailImageData
    }
}

public final class ContactsProvider: ResultProvider, @unchecked Sendable {
    public let id = "contacts"
    public let speed = Speed.full
    let source: ContactSource
    let requestAccess: @Sendable () async -> Bool
    let board: @Sendable () -> NSPasteboard
    public var limit = 4

    /// `requestAccess` is wired by the app to `host.request(.contacts, reason:)`.
    public init(source: ContactSource = SystemContacts(), requestAccess: @escaping @Sendable () async -> Bool,
                board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.source = source; self.requestAccess = requestAccess; self.board = board
    }

    static let personish = try! NSRegularExpression(pattern: #"^[\p{L}][\p{L}'.-]*(\s[\p{L}][\p{L}'.-]*){0,2}$"#)

    /// Could this be someone's name: letters, at most three words, no digits, 3+ characters.
    public static func personLike(_ t: String) -> Bool {
        t.count >= 3 && personish.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
    }

    public static func initials(_ name: String) -> String {
        let ws = name.split(whereSeparator: { $0.isWhitespace }).compactMap(\.first)
        return String((ws.count > 1 ? [ws.first!, ws.last!] : Array(ws.prefix(1)))).uppercased()
    }

    public func results(for query: Query) async -> [ResultItem] {
        let q = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = q.contains("@") && q.contains(".")
        guard Self.personLike(q) || email else { return [] }
        switch source.status() {
        case .notAsked: return [grantRow()]
        case .granted: break
        default: return []
        }
        return source.search(q, limit: limit).compactMap { p in
            let label = p.name.isEmpty ? (p.emails.first ?? "") : p.name
            let s = max(Match.score(q, label), p.emails.contains { $0.caseInsensitiveCompare(q) == .orderedSame } ? 1 : 0)
            return s > 0 ? row(p, label: label, score: s) : nil
        }
    }

    static func copyText(_ s: String, _ b: NSPasteboard) -> Bool { b.clearContents(); return b.setString(s, forType: .string) }

    func grantRow() -> ResultItem {
        let ask = requestAccess
        return ResultItem(id: "grant:contacts", kind: "grant", title: "Show contacts here", subtitle: "macOS asks once. They stay on this Mac.",
                          icon: .symbol("person.crop.circle.badge.plus", .signal), section: .people, score: 0.2, actions: [
                            ResultAction(id: "grant", title: "Show contacts here", symbol: "person.crop.circle.badge.plus",
                                         shortcut: KeyShortcut("return")) { _, _ in
                                await ask() ? .said("Contacts will show here now.")
                                    : .failed("Contacts are off for Vyre. Turn them on in System Settings, Privacy & Security, Contacts.")
                            },
                          ])
    }

    func row(_ p: Person, label: String, score: Double) -> ResultItem {
        let url = URL(string: "addressbook://" + (p.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? p.id))
        let board = self.board
        var actions: [ResultAction] = [
            ResultAction(id: "open", title: "Open in Contacts", symbol: "person.crop.circle", shortcut: KeyShortcut("return")) { _, _ in
                guard let url else { return .failed("That contact has no address.") }
                return await Launch.open(url)
            },
        ]
        if let e = p.emails.first {
            actions.append(ResultAction(id: "copy-email", title: "Copy email", symbol: "envelope", shortcut: KeyShortcut("c", command: true, shift: true)) { _, _ in
                Self.copyText(e, board()) ? .said("Copied \(e)") : .failed("Could not copy it.")
            })
            if let mail = URL(string: "mailto:" + e) {
                actions.append(ResultAction(id: "email", title: "New email", symbol: "square.and.pencil") { _, _ in
                    await Launch.open(mail)
                })
            }
        }
        if let ph = p.phones.first {
            actions.append(ResultAction(id: "copy-phone", title: "Copy phone", symbol: "phone") { _, _ in
                Self.copyText(ph, board()) ? .said("Copied \(ph)") : .failed("Could not copy it.")
            })
        }
        return ResultItem(id: "contact:" + p.id, kind: "contact", title: label, subtitle: p.org.isEmpty ? (p.emails.first ?? "") : p.org,
                          icon: .contact(p.id, initials: Self.initials(label)), section: .people, score: score, actions: actions,
                          copyText: p.emails.first ?? label, payload: ["contact": p.id])
    }
}
