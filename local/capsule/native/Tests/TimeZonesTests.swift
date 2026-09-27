// TimeZones tests: `now` and the local zone are injected, so these hold on any Mac, any day.

import Foundation

// capsule-suite: timeZonesSuite
let timeZonesSuite = Suite("timezones") { t in
    // Sunday 27 September 2026, 12:00 UTC. London is on BST, New York on EDT, Los Angeles on PDT.
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let now = utc.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 12))!
    let kl = TimeZone(identifier: "Asia/Kuala_Lumpur")!
    func ev(_ s: String, use24h: Bool = false) -> TimeAnswer? { TimeZones.evaluate(s, now: now, local: kl, use24h: use24h) }

    t.test("what time is it there") {
        let a = ev("time in tokyo")
        t.eq(a?.label, "9:00 PM")
        t.eq(a?.sub, "Tokyo · Sun 27 Sep · UTC+9 · 1 h ahead")
        t.eq(a?.id, "time:Asia/Tokyo")
        t.eq(ev("tokyo time")?.label, "9:00 PM")
        t.eq(ev("What time is it in Tokyo?")?.label, "9:00 PM")
        t.eq(ev("time in new york")?.label, "8:00 AM")
        t.eq(ev("nyc time")?.sub, "New York · Sun 27 Sep · UTC-4 · 12 h behind")
        t.eq(ev("time in kuala lumpur")?.sub, "Kuala Lumpur · Sun 27 Sep · UTC+8 · same time as here")
        t.eq(ev("time in asia/kolkata")?.sub, "Asia/Kolkata · Sun 27 Sep · UTC+5:30 · 2 h 30 min behind")
        t.eq(ev("time in delhi")?.label, "5:30 PM")
        t.eq(ev("utc time")?.label, "12:00 PM")
        t.eq(ev("time in tokyo", use24h: true)?.label, "21:00")
    }

    t.test("a clock in one zone shown in another") {
        let a = ev("3pm london in new york")
        t.eq(a?.label, "10:00 AM")
        t.eq(a?.sub, "3:00 PM in London is 10:00 AM in New York · UTC-4")
        t.eq(a?.zone, "America/New_York")
        t.eq(ev("10:30 pst to cet")?.label, "7:30 PM")
        t.eq(ev("10:30 pst to cet")?.sub, "10:30 AM in Pacific time is 7:30 PM in Central Europe · UTC+2")
        t.eq(ev("3 pm london in new york")?.label, "10:00 AM")
        t.eq(ev("noon utc in tokyo")?.label, "9:00 PM")
        t.eq(ev("15:00 london in tokyo", use24h: true)?.label, "23:00")
        t.eq(ev("12am utc to est")?.label, "8:00 PM (previous day)")
        t.eq(ev("11pm new york in tokyo")?.label, "12:00 PM (next day)")
    }

    t.test("one side missing means here") {
        t.eq(ev("3pm tokyo")?.label, "2:00 PM")
        t.eq(ev("3pm tokyo")?.sub, "3:00 PM in Tokyo is 2:00 PM here · UTC+8")
        t.eq(ev("3pm in tokyo")?.label, "4:00 PM")
        t.ok(ev("3pm in kuala lumpur") == nil, "same zone as here")
    }

    t.test("not a time question is nil") {
        for q in ["", "tokyo", "time", "time in", "time in narnia", "screen time", "lunch time", "10:30", "3pm",
                  "3 london in new york", "25:00 utc to pst", "13pm utc in pst", "3:5pm london", "3pm london in narnia",
                  "3pm london in", "run time", "10 30 pst", "0pm utc"] {
            let r = ev(q)
            t.ok(r == nil, "\(q) gave \(String(describing: r?.label))")
        }
    }

    t.test("timeResult row") {
        guard let row = timeResult(Query("time in tokyo"), now: now, local: kl) else { t.ok(false, "no row"); return }
        t.eq(row.kind, "time")
        t.eq(row.section, .answer)
        t.eq(row.icon, .symbol("clock", .signal))
        t.eq(row.copyText, "9:00 PM")
    }

    t.test("fast after the first build") {
        _ = ev("time in tokyo")
        let n = 500, start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<n { _ = ev("3pm london in new york"); _ = ev("hello world") }
        let per = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / Double(2 * n)
        print("timezones: \(String(format: "%.4f", per)) ms per call (unoptimized test build)")
        t.ok(per < 1)
    }
}
