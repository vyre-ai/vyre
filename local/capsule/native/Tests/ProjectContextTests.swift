// capsule-suite: projectContextSuite
// The Capsule's current project (Host/ProjectContext.swift): the session window's first, then the
// project holding the front document or folder, else none. Pure: no real window is read here.

import Foundation

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
}
