// capsule-suite: driveGuardSuite
// Drive mode hands a process the panel's rows and keys: it starts only for a test run in a throwaway home.

import Foundation

let driveGuardSuite = Suite("drive guard") { t in
    t.test("drive needs the drive variable, the test marker and a VYRE_HOME under the temp folder") {
        let tmp = NSTemporaryDirectory()
        let home = (tmp as NSString).appendingPathComponent("vyre-capsule-check-x")
        let ok: [String: String] = ["VYRE_CAPSULE_DRIVE": "1", "VYRE_CAPSULE_TEST": "1", "VYRE_HOME": home]
        t.ok(DriveGuard.allowed(ok))
        var a = ok; a["VYRE_CAPSULE_TEST"] = nil; t.ok(!DriveGuard.allowed(a), "no test marker")
        var b = ok; b["VYRE_CAPSULE_DRIVE"] = nil; t.ok(!DriveGuard.allowed(b), "no drive variable")
        var c = ok; c["VYRE_HOME"] = nil; t.ok(!DriveGuard.allowed(c), "no home named")
        var d = ok; d["VYRE_HOME"] = NSHomeDirectory() + "/.vyre"; t.ok(!DriveGuard.allowed(d), "a person's own home")
        var e = ok; e["VYRE_HOME"] = tmp; t.ok(!DriveGuard.allowed(e), "the temp folder itself is not a home")
        var f = ok; f["VYRE_HOME"] = tmp + "../escape"; t.ok(!DriveGuard.allowed(f), "a path that climbs out")
        t.ok(DriveGuard.allowed(ok, temp: tmp + "/"), "a trailing slash on the temp folder is fine")
    }
}
