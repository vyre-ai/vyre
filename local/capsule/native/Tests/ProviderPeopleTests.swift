// capsule-suite: providerPeopleSuite
// Contacts against a fake source (real contacts are never enumerated in a test), the dictionary,
// and the icon cache.

import AppKit
import Foundation

final class FakeContacts: ContactSource, @unchecked Sendable {
    var state: PermissionState
    var people: [Person]
    var searched = 0
    init(_ state: PermissionState, _ people: [Person] = []) { self.state = state; self.people = people }
    func status() -> PermissionState { state }
    func search(_ q: String, limit: Int) -> [Person] {
        searched += 1
        return Array(people.filter { $0.name.localizedCaseInsensitiveContains(q) || $0.emails.contains(q) }.prefix(limit))
    }
}

final class AskLog: @unchecked Sendable { var asked = 0; var answer = false }

let providerPeopleSuite = Suite("provider people") { t in
    let ann = Person(id: "A1", name: "Ann Lee", org: "Harlow Legal", emails: ["ann@harlow.example"], phones: ["+1 555 0100"])
    let bo = Person(id: "B2", name: "Bo Reyes", emails: ["bo@northwind.example"])

    t.test("contacts: until asked, one grant row under People, and its action asks through the host") {
        let src = FakeContacts(.notAsked, [ann])
        let log = AskLog()
        let p = ContactsProvider(source: src, requestAccess: { log.asked += 1; return log.answer })
        let rows = t.wait { await p.results(for: Query("ann lee")) } ?? []
        t.eq(rows.map(\.kind), ["grant"])
        t.eq(rows.first?.title, "Show contacts here")
        t.eq(rows.first?.section, .people)
        t.eq(rows.first?.section.rawValue, "People")
        t.eq(src.searched, 0, "nothing read before access")
        t.eq(log.asked, 0, "typing never asks")
        let ctx = ActionContext(query: Query("ann lee"))
        t.eq(t.wait { await rows[0].actions[0].run(rows[0], ctx) },
             .failed("Contacts are off for Lumen. Turn them on in System Settings, Privacy & Security, Contacts."))
        log.answer = true
        t.eq(t.wait { await rows[0].actions[0].run(rows[0], ctx) }, .said("Contacts will show here now."))
        t.eq(log.asked, 2)
        t.eq(t.wait { await p.results(for: Query("2026")) }?.count, 0, "not a name, no row")
    }

    t.test("contacts: denied or restricted shows nothing at all") {
        for s in [PermissionState.denied, .restricted] {
            let p = ContactsProvider(source: FakeContacts(s, [ann]), requestAccess: { true })
            t.eq(t.wait { await p.results(for: Query("ann")) }?.count, 0)
        }
    }

    t.test("contacts: granted, people rows with initials, email copy and the People section") {
        let src = FakeContacts(.granted, [ann, bo])
        let p = ContactsProvider(source: src, requestAccess: { true }, board: { NSPasteboard(name: testBoardName) })
        let rows = t.wait { await p.results(for: Query("ann")) } ?? []
        t.eq(rows.map(\.title), ["Ann Lee"])
        let r = rows.first
        t.eq(r?.id, "contact:A1")
        t.eq(r?.subtitle, "Harlow Legal")
        t.eq(r?.section, .people)
        t.eq(r?.icon, .contact("A1", initials: "AL"))
        t.eq(r?.actions.map(\.id), ["open", "copy-email", "email", "copy-phone"])
        let board = NSPasteboard(name: testBoardName)
        defer { board.releaseGlobally() }
        t.eq(t.wait { await r!.actions[1].run(r!, ActionContext(query: Query("ann"))) }, .said("Copied ann@harlow.example"))
        t.eq(board.string(forType: .string), "ann@harlow.example")
        let byMail = t.wait { await p.results(for: Query("bo@northwind.example")) } ?? []
        t.eq(byMail.map(\.title), ["Bo Reyes"], "an exact email finds its person")
        t.eq(byMail.first?.subtitle, "bo@northwind.example")
        t.eq(ContactsProvider.initials("Juno"), "J")
        t.eq(ContactsProvider.initials("alex van der kit"), "AK")
        t.ok(ContactsProvider.personLike("Ann Lee") && ContactsProvider.personLike("José") && !ContactsProvider.personLike("ab")
             && !ContactsProvider.personLike("r2d2") && !ContactsProvider.personLike("one two three four"))
    }

    t.test("contacts: the system source reads its status without asking") {
        // Status only: it never raises a dialog. Nothing is searched.
        let s = SystemContacts().status()
        t.ok([.granted, .denied, .restricted, .notAsked].contains(s))
    }

    t.test("dictionary: the words that ask, and the gist") {
        t.eq(DictionaryProvider.word("define serendipity"), "serendipity")
        t.eq(DictionaryProvider.word("serendipity meaning"), "serendipity")
        t.eq(DictionaryProvider.word("what does serendipity mean?"), "serendipity")
        t.eq(DictionaryProvider.word("serendipity"), nil)
        let text = "serendipity ser·en·dip·i·ty | ˌserənˈdipədē | noun the occurrence and development of events by chance in a happy or beneficial way: a fortunate stroke of serendipity."
        t.eq(DictionaryProvider.firstSentence(text), "the occurrence and development of events by chance in a happy or beneficial way")
        let p = DictionaryProvider(lookup: { $0 == "no way" ? text : nil })
        let r = t.wait { await p.results(for: Query("define no way")) }?.first
        t.eq(r?.kind, "define")
        t.eq(r?.id, "define:no way")
        t.eq(r?.section, .answer)
        t.eq(r?.copyText, "the occurrence and development of events by chance in a happy or beneficial way")
        t.eq(t.wait { await p.results(for: Query("define qzx")) }?.count, 0)
    }

    t.test("dictionary: the system dictionary answers") {
        let r = t.wait { await DictionaryProvider().results(for: Query("define serendipity")) }?.first
        t.ok(r?.subtitle.contains("chance") ?? false, r?.subtitle ?? "no entry")
    }

    t.test("icons: rendered at points times scale, cached, tinted with the tokens") {
        let dir = providerFixture("icons")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let r = t.wait { @MainActor () -> [String] in
            IconCache.darkOverride = true
            defer { IconCache.darkOverride = nil }
            let c = IconCache(countLimit: 50, contactPhoto: { _ in nil })
            var log: [String] = []
            let a = c.image(.file("/System/Applications/Calculator.app"), points: 20, scale: 2)
            let rep = a?.representations.first as? NSBitmapImageRep
            log.append("\(a?.representations.count ?? 0) \(rep?.pixelsWide ?? 0)x\(rep?.pixelsHigh ?? 0) \(Int(a?.size.width ?? 0))pt")
            let again = c.image(.file("/System/Applications/Calculator.app"), points: 20, scale: 2)
            log.append("same:\(a === again) renders:\(c.renders)")
            let sw = c.image(.swatch(r: 1, g: 0, b: 0), points: 10, scale: 1)
            let px = (sw?.representations.first as? NSBitmapImageRep)?.colorAt(x: 5, y: 5)?.usingColorSpace(.sRGB)
            log.append("swatch:\(Int((px?.redComponent ?? 0) * 255)),\(Int((px?.greenComponent ?? 1) * 255))")
            let sym = c.image(.symbol("circle.fill", .signal), points: 20, scale: 2)
            let srep = sym?.representations.first as? NSBitmapImageRep
            let mid = srep?.colorAt(x: 20, y: 20)?.usingColorSpace(.sRGB)
            log.append("signal:\(Int(((mid?.redComponent ?? 0) * 255).rounded())),\(Int(((mid?.greenComponent ?? 0) * 255).rounded())),\(Int(((mid?.blueComponent ?? 0) * 255).rounded()))")
            let ini = c.image(.contact("X1", initials: "AL"), points: 16, scale: 2)
            log.append("initials:\((ini?.representations.first as? NSBitmapImageRep)?.pixelsWide ?? 0)")
            log.append("bundle:\(c.image(.bundle("com.apple.finder"), points: 16, scale: 2) != nil)")
            log.append("none:\(c.image(.none, points: 16, scale: 2) == nil)")
            log.append("glyph:\(c.image(.glyph("🍞"), points: 16, scale: 2) != nil) mark:\(c.image(.mark, points: 16, scale: 2) != nil)")
            for i in 0..<60 { _ = c.image(.glyph("\(i)"), points: 16, scale: 1) }
            c.keepOnCool = 5
            c.cool()
            log.append("after cool:\(c.count)")
            c.purge()
            log.append("after purge:\(c.count)")
            return log
        }
        t.eq(r, ["1 40x40 20pt", "same:true renders:1", "swatch:255,0", "signal:198,243,107", "initials:32", "bundle:true", "none:true",
                 "glyph:true mark:true", "after cool:5", "after purge:0"])
    }

    t.test("icons: a contact photo is used when there is one, and an image file gets a thumbnail") {
        let dir = providerFixture("thumbs")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        // A 64 px red PNG, written by this test.
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let red = NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1)
        for x in 0..<64 { for y in 0..<64 { rep.setColor(red, atX: x, y: y) } }
        let png = rep.representation(using: .png, properties: [:])!
        try? png.write(to: URL(fileURLWithPath: dir + "/northwind.png"))
        let r = t.wait(timeout: 15) { @MainActor () -> [String] in
            let c = IconCache(contactPhoto: { $0 == "P1" ? png : nil })
            var log: [String] = []
            let photo = c.image(.contact("P1", initials: "AL"), points: 16, scale: 2)
            let px = (photo?.representations.first as? NSBitmapImageRep)?.colorAt(x: 16, y: 16)?.usingColorSpace(.sRGB)
            log.append("photo red:\((px?.redComponent ?? 0) > 0.9)")
            var ready = false
            let first = c.image(.file(dir + "/northwind.png"), points: 32, scale: 2, ready: { img in
                ready = (img.representations.first as? NSBitmapImageRep)?.pixelsWide == 64
            })
            log.append("type icon now:\(first != nil)")
            let until = Date().addingTimeInterval(10)
            while !ready && Date() < until { try? await Task.sleep(nanoseconds: 20_000_000) }
            log.append("thumbnail:\(ready)")
            return log
        }
        t.eq(r, ["photo red:true", "type icon now:true", "thumbnail:true"])
    }
}
