// capsule-suite: kitSuite
let kitSuite = Suite("kit") { t in
    t.test("a query is normalized") { t.eq(Query("  Open   Safari ").normalized, "open safari") }
    t.test("dialogs are off in a test") { t.ok(!dialogsAllowed(["VYRE_CAPSULE_TEST": "1"])) }
    t.test("the lead can allow dialogs") { t.ok(dialogsAllowed(["VYRE_CAPSULE_TEST": "1", "VYRE_TEST_DIALOGS": "1"])) }
}
