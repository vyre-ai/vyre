// capsule-suite: projectContextSuite
// The Capsule's current project (Host/ProjectContext.swift): the session window's first, then the
// project holding the front document or folder, else none. Pure: no real window is read here.

import AppKit
import SwiftUI

private let harlow = VyreProject(slug: "harlow", name: "Harlow Legal", home: "/Users/alex/Work/Harlow")
private let intake = VyreProject(slug: "harlow-intake", name: "Harlow intake", home: "/Users/alex/Work/Harlow/intake/")
private let bakery = VyreProject(slug: "northwind", name: "Northwind Bakery", home: "/Users/alex/Work/Northwind")
private let noHome = VyreProject(slug: "loose", name: "Loose ends")
private let CAT = VyreCatalog(projects: [harlow, intake, bakery, noHome],
                              threads: [VyreThread(id: "t-harlow", label: "intake form", project: "harlow"), VyreThread(id: "t-none", label: "scratch")])

let projectContextSuite = Suite("project context") { t in
    t.test("the session window in front decides first") {
        t.eq(ProjectContext.current(sessionThread: "t-harlow", sessionProject: nil, frontPath: "/Users/alex/Work/Northwind/menu.md", catalog: CAT)?.slug, "harlow",
             "the session's thread's project, not the front document's")
        t.eq(ProjectContext.current(sessionThread: nil, sessionProject: "northwind", frontPath: nil, catalog: CAT)?.slug, "northwind")
        t.eq(ProjectContext.current(sessionThread: "t-none", sessionProject: nil, frontPath: "/Users/alex/Work/Northwind/menu.md", catalog: CAT)?.slug, nil,
             "a session with no project is no project: the front app is not asked instead")
    }

    t.test("else the project whose folder holds the front document or working directory") {
        func at(_ p: String?) -> String? { ProjectContext.current(sessionThread: nil, sessionProject: nil, frontPath: p, catalog: CAT)?.slug }
        t.eq(at("/Users/alex/Work/Northwind/menu.md"), "northwind")
        t.eq(at("/Users/alex/Work/Northwind"), "northwind", "the folder itself (a Terminal window's working directory)")
        t.eq(at("/Users/alex/Work/Harlow/intake/form.pdf"), "harlow-intake", "the deepest home wins")
        t.eq(at("/Users/alex/Work/Harlow/brief.md"), "harlow")
        t.eq(at("/Users/alex/Work/HarlowOld/brief.md"), nil, "a name that only starts the same is not inside")
        t.eq(at("/Users/alex/Work/Harlow/../Northwind/x"), "northwind", "standardised first")
        t.eq(at("/Users/alex/Desktop/notes.txt"), nil)
        t.eq(at(nil), nil, "nothing known: none")
        t.eq(at("relative/path"), nil)
    }

    t.test("file URLs from AXDocument, and password managers are never read") {
        t.eq(ProjectContext.fileURLPath("file:///Users/alex/Work/Harlow/brief%20v2.md"), "/Users/alex/Work/Harlow/brief v2.md")
        t.eq(ProjectContext.fileURLPath("/Users/alex/x"), "/Users/alex/x")
        t.eq(ProjectContext.fileURLPath("https://harlow.example/doc"), nil)
        t.ok(ProjectContext.isPrivate("com.1password.1password") && ProjectContext.isPrivate("com.apple.keychainaccess"))
        t.ok(!ProjectContext.isPrivate("com.apple.Terminal") && !ProjectContext.isPrivate("com.apple.keychainaccessory"))
        MainActor.assumeIsolated {
            t.eq(ProjectContext.frontPath(nil), nil)
            t.eq(ProjectContext.frontPath(FrontApp(bundle: "com.1password.1password", pid: 1, name: "1Password")), nil, "refused before any window is touched")
        }
    }

    t.test("memory.ask carries context:{project}: the session window's, then the front document's, never a guess") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "Rye and sourdough.", "confidence": 0.8, "sources": []] }
        let out: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in
                let m = CapsuleModel(home: vyScratch("proj-home"), vyred: VyredClient(socket: v.socket), providers: [])
                m.catalog = CAT
                m.frontPath = { _ in "/Users/alex/Work/Northwind/menu.md" }
                return m
            }
            _ = await m.vyred.refreshTools()
            var got: [String] = []
            func ask() async {
                _ = await m.askIQ("what is on the menu today")
                let c = v.callsOf("memory.ask").last?["context"] as? [String: Any]
                got.append(VJ.str(c?["project"]) ?? "none")
            }
            await MainActor.run { m.refreshProject() }
            await ask()
            await MainActor.run { m.sessionShown(thread: "t-harlow", project: nil) }
            await ask()
            await MainActor.run { m.sessionShown(thread: "", project: nil) }     // the assistant's tab
            await ask()
            await MainActor.run { m.sessionShown(thread: nil, project: nil) }    // the window closed
            await ask()
            await MainActor.run { m.frontPath = { _ in "/Users/alex/Desktop/x.txt" }; m.refreshProject() }
            await ask()
            return got
        }
        t.eq(out, ["northwind", "harlow", "none", "northwind", "none"])
    }

    t.test("the bar shows the project's tile and name") {
        let ok: Bool = MainActor.assumeIsolated {
            let m = CapsuleModel(home: vyScratch("proj-view"), vyred: VyredClient(socket: vyScratch("pv") + "/none.sock"), providers: [])
            m.catalog = CAT
            m.sessionShown(thread: nil, project: "northwind")
            guard m.currentProject?.name == "Northwind Bakery" else { return false }
            let host = NSHostingView(rootView: CapsuleView(model: m, focus: FocusTicket(), snapshot: true))
            host.frame = NSRect(x: 0, y: 0, width: Theme.width, height: CapsuleLayout.panelHeight(m))
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
            host.cacheDisplay(in: host.bounds, to: rep)
            if let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"], let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("project-chip.png"))
            }
            return rep.pixelsWide > 0
        }
        t.ok(ok)
    }
}
