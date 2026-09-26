// capsule-suite: matchSuite
let matchSuite = Suite("match") { t in
    t.test("tiers") {
        t.eq(Match.score("safari", "Safari"), 1)
        t.eq(Match.score("saf", "Safari"), 0.9)
        t.eq(Match.score("code", "Visual Studio Code"), 0.8)
        t.eq(Match.score("vsc", "Visual Studio Code"), 0.8)
        t.eq(Match.score("studio c", "Visual Studio Code"), 0.5)
        t.eq(Match.score("vscd", "Visual Studio Code"), 0.3)
        t.eq(Match.score("zzz", "Safari"), 0)
    }
    t.test("camelCase and accents") {
        t.eq(Match.words("VisualStudio Code"), ["visual", "studio", "code"])
        t.eq(Match.score("cafe", "Café"), 1)
    }
    t.test("synonyms count a little less") { t.eq(Match.score("wifi", "Network", synonyms: ["wifi"]), 0.95) }
}
