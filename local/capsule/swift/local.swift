// local: the Capsule's on-device lookups that Node cannot reach: Contacts and the Dictionary.
//
//   local contacts --status              the Contacts permission, never prompting
//   local contacts <query> [--limit N]   people whose name (or exact email) matches
//   local define <word>                  the system dictionary's definition, or null
//   local serve                          one JSON request per stdin line, one JSON answer each
//
// Every answer is one JSON line on stdout. The Capsule runs `serve` as a long-lived child: a
// process spawn per keystroke costs more than the lookup itself, and the launcher's budget is a
// few tens of milliseconds. Requests in serve mode look like
//   {"id":1,"op":"contacts","q":"ann","limit":5}   {"id":2,"op":"define","q":"serendipity"}
//   {"id":3,"op":"status"}
// and each answer carries the same id. Answers can arrive out of order: a contacts fetch never
// holds up a definition. Serve exits when stdin closes, so a crashed Capsule leaves nothing.
//
// Nothing here touches the network or writes anything down (proposal section 5). A query goes in,
// matches come out, and neither is kept.
//
// Only `contacts <query>` may ask for the Contacts permission, and only while macOS has never
// been asked (notDetermined). `--status` and the serve `status` op read it without asking, so
// the Capsule can say why it wants access before the dialog appears. In serve mode the ask does
// not block: the first contacts request answers {"error":"asking"} at once and the dialog runs
// on its own; the next request after the user answers gets real results.
//
// Whose permission it is: macOS (TCC) attributes the ask to the RESPONSIBLE process, not to this
// binary. Spawned from the Capsule, that is the Electron app: the packaged Vyre app, or
// Electron.app itself in development. Run from a shell, it is the terminal. The grant appears
// under that app's name in Privacy & Security > Contacts, and that app's Info.plist must carry
// NSContactsUsageDescription or macOS refuses without showing a dialog. build.sh also embeds an
// Info.plist with that key in this binary, which covers the case where it is its own
// responsible process (launched by launchd, or by a parent that disclaims responsibility).
//
// build: local/capsule/build.sh

import Foundation
import Contacts
import CoreServices

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        outLock.lock()
        print(s)
        fflush(stdout)
        outLock.unlock()
    }
}

// MARK: contacts

func statusName() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default: return "limited"   // CNAuthorizationStatusLimited (raw 4) is not named in the macOS SDK
    }
}

let store = CNContactStore()
let keys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
]

func shape(_ c: CNContact) -> [String: Any] {
    let name = CNContactFormatter.string(from: c, style: .fullName) ?? ""
    return [
        "id": c.identifier,
        "name": name.isEmpty ? (c.organizationName) : name,
        "org": c.organizationName,
        "emails": c.emailAddresses.map { $0.value as String },
        "phones": c.phoneNumbers.map { $0.value.stringValue },
    ]
}

/// The matches, or an error answer. Assumes access was already granted.
func search(_ q: String, limit: Int) -> [String: Any] {
    let query = q.trimmingCharacters(in: .whitespaces)
    if query.isEmpty { return ["contacts": []] }
    var seen = Set<String>()
    var out: [[String: Any]] = []
    do {
        var found = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
        // An email match is cheap only as an exact address: Contacts indexes it that way.
        if query.contains("@") && query.contains(".") {
            found += try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: query), keysToFetch: keys)
        }
        for c in found where !seen.contains(c.identifier) {
            seen.insert(c.identifier)
            out.append(shape(c))
            if out.count >= limit { break }
        }
    } catch {
        return ["error": "fetch", "message": error.localizedDescription, "status": statusName()]
    }
    return ["contacts": out]
}

/// `wait`: the one-shot CLI waits for the user to answer the dialog; serve mode does not.
func contacts(_ q: String, limit: Int, wait: Bool) -> [String: Any] {
    switch statusName() {
    case "authorized", "limited":
        return search(q, limit: limit)
    case "notDetermined":
        if !wait {
            store.requestAccess(for: .contacts) { _, _ in }
            return ["error": "asking", "status": "notDetermined"]
        }
        let done = DispatchSemaphore(value: 0)
        var granted = false
        store.requestAccess(for: .contacts) { ok, _ in granted = ok; done.signal() }
        done.wait()
        return granted ? search(q, limit: limit) : ["error": "denied", "status": statusName()]
    case let s:
        return ["error": "denied", "status": s]
    }
}

// MARK: dictionary

func define(_ word: String) -> [String: Any] {
    let w = word.trimmingCharacters(in: .whitespacesAndNewlines)
    let ns = w as NSString
    guard ns.length > 0,
          let def = DCSCopyTextDefinition(nil, w as CFString, CFRange(location: 0, length: ns.length))?.takeRetainedValue() as String?
    else { return ["word": w, "definition": NSNull()] }
    var text = def.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.count > 600 { text = String(text.prefix(600)).trimmingCharacters(in: .whitespaces) + "..." }
    return ["word": w, "definition": text]
}

// MARK: entry

let args = Array(CommandLine.arguments.dropFirst())

func limitArg() -> Int {
    if let i = args.firstIndex(of: "--limit"), i + 1 < args.count, let n = Int(args[i + 1]), n > 0 { return n }
    return 8
}

switch args.first {
case "contacts":
    if args.contains("--status") { emit(["status": statusName()]); exit(0) }
    var rest = Array(args.dropFirst())
    if let i = rest.firstIndex(of: "--limit") { rest.removeSubrange(i...min(i + 1, rest.count - 1)) }
    emit(contacts(rest.joined(separator: " "), limit: limitArg(), wait: true))
    exit(0)
case "define":
    emit(define(args.dropFirst().joined(separator: " ")))
    exit(0)
case "serve":
    let work = DispatchQueue(label: "run.vyre.local.work", attributes: .concurrent)
    let group = DispatchGroup()
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { emit(["error": "bad request"]) }
            continue
        }
        let id = req["id"] ?? NSNull()
        let q = req["q"] as? String ?? ""
        let limit = (req["limit"] as? Int).map { max(1, $0) } ?? 8
        work.async(group: group) {
            var ans: [String: Any]
            switch req["op"] as? String {
            case "status": ans = ["status": statusName()]
            case "contacts": ans = contacts(q, limit: limit, wait: false)
            case "define": ans = define(q)
            default: ans = ["error": "unknown op"]
            }
            ans["id"] = id
            emit(ans)
        }
    }
    group.wait()
    exit(0)
default:
    FileHandle.standardError.write("usage: local contacts --status | contacts <query> [--limit N] | define <word> | serve\n".data(using: .utf8)!)
    emit(["error": "usage"])
    exit(64)
}
