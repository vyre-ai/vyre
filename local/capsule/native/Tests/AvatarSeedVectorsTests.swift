// capsule-suite: avatarSeedVectorsSuite
// projectBytes against ADR 0043 section 1's six vectors (app-design 2d31607e; the shared JS is
// native-core's lib/avatar-seed/index.js, da640918): UTF-16 code units, surrogate pairs included.

import Foundation

let avatarSeedVectorsSuite = Suite("avatar seed vectors") { t in
    t.test("projectBytes matches ADR 0043's vectors, byte for byte") {
        let vectors: [(String, String)] = [
            ("harlow-legal", "ee53a80eb372fa43"),
            ("northwind", "3b03f25e73bb44e5"),
            ("9d0e4c1a-5b2f-4c1e-9a0b-3f2d1c0b9a88", "3298bd291db714fc"),
            ("", "b9de60c138d8b8f0"),
            ("café-menu", "3a3a125825ad9923"),
            ("\u{1F35E} bakery", "3607ac119874645a"),
        ]
        for (seed, hex) in vectors {
            t.eq(Avatars.projectBytes(seed).map { String(format: "%02x", $0) }.joined(), hex, seed)
        }
    }
}
