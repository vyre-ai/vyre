// TimeZones: "time in tokyo", "tokyo time", "3pm london in new york", "10:30 pst to cet".
//
// Offline: macOS carries the whole tz database, so a zone is a TimeZone identifier and the only
// data here is a small table of the names people type that are not identifiers (abbreviations,
// "nyc", "delhi"). Every city that names a zone ("Asia/Tokyo" -> tokyo) is found from the
// identifiers themselves, built once on first use.
//
// A false positive is worse than a miss: a clock needs am/pm or a colon ("3pm", "15:00"; a bare
// "3" is a count), a place must resolve to a zone, and the whole query must be one of the shapes
// above. Abbreviations mean the region, not the fixed offset: "pst" typed in July means Pacific
// time, which is what the person wants to plan around.
//
// `now`, the local zone and 12/24-hour display are injected, so the answers are deterministic in
// tests and nothing here reads the clock or the user's settings by itself. Formatting is done by
// hand from calendar components (no DateFormatter, no locale) to stay cheap on every keystroke.

import Foundation

public struct TimeAnswer: Sendable, Equatable {
    public var id: String
    public var label: String
    public var sub: String
    public var copy: String
    /// The zone the answer is shown in.
    public var zone: String
}

public enum TimeZones {
    struct Place { let id: String; let name: String }

    /// Names that are not the last part of an identifier.
    static let extra: [String: Place] = {
        var m: [String: Place] = [:]
        func add(_ id: String, _ name: String, _ keys: [String]) { for k in keys { m[k] = Place(id: id, name: name) } }
        add("America/Los_Angeles", "Pacific time", ["pst", "pdt", "pt", "pacific", "pacific time"])
        add("America/Denver", "Mountain time", ["mst", "mdt", "mountain time"])
        add("America/Chicago", "Central time", ["cst", "cdt", "ct", "central time"])
        add("America/New_York", "Eastern time", ["est", "edt", "et", "eastern", "eastern time"])
        add("America/Anchorage", "Alaska", ["akst", "akdt", "alaska"])
        add("Pacific/Honolulu", "Hawaii", ["hst", "hawaii"])
        add("UTC", "UTC", ["utc", "z", "zulu"])
        add("GMT", "GMT", ["gmt"])
        add("Europe/London", "London", ["bst", "uk", "england"])
        add("Europe/Paris", "Central Europe", ["cet", "cest"])
        add("Europe/Athens", "Eastern Europe", ["eet", "eest"])
        add("Europe/Lisbon", "Western Europe", ["wet", "west"])
        add("Asia/Kolkata", "India", ["ist", "india", "delhi", "new delhi", "mumbai", "bombay", "bangalore", "bengaluru", "chennai", "hyderabad", "kolkata", "calcutta"])
        add("Europe/Kiev", "Kyiv", ["kyiv", "kiev", "ukraine"])
        add("Asia/Saigon", "Ho Chi Minh City", ["ho chi minh", "ho chi minh city", "saigon", "hanoi", "vietnam"])
        add("Asia/Karachi", "Pakistan", ["pkt", "pakistan", "lahore", "islamabad"])
        add("Asia/Tokyo", "Tokyo", ["jst", "japan", "osaka", "kyoto"])
        add("Asia/Seoul", "Seoul", ["kst", "korea"])
        add("Asia/Shanghai", "China", ["china", "beijing", "shenzhen", "guangzhou"])
        add("Asia/Hong_Kong", "Hong Kong", ["hkt"])
        add("Asia/Singapore", "Singapore", ["sgt"])
        add("Asia/Kuala_Lumpur", "Kuala Lumpur", ["myt", "kl", "malaysia"])
        add("Asia/Bangkok", "Bangkok", ["ict", "thailand", "phuket"])
        add("Asia/Dubai", "Dubai", ["gst", "uae", "abu dhabi"])
        add("Asia/Jakarta", "Jakarta", ["wib", "indonesia"])
        add("Asia/Manila", "Manila", ["philippines"])
        add("Australia/Sydney", "Sydney", ["aest", "aedt", "canberra"])
        add("Australia/Perth", "Perth", ["awst"])
        add("Pacific/Auckland", "Auckland", ["nzst", "nzdt", "new zealand", "wellington"])
        add("America/New_York", "New York", ["nyc", "ny", "boston", "washington", "dc", "miami", "atlanta", "philadelphia"])
        add("America/Los_Angeles", "Los Angeles", ["la", "sf", "san francisco", "seattle", "san diego", "silicon valley"])
        add("America/Chicago", "Chicago", ["dallas", "houston", "austin"])
        add("America/Toronto", "Toronto", ["ottawa", "montreal"])
        add("America/Sao_Paulo", "Sao Paulo", ["brazil", "rio", "rio de janeiro"])
        add("Europe/Berlin", "Berlin", ["germany", "munich", "frankfurt"])
        add("Europe/Paris", "Paris", ["france"])
        add("Europe/Istanbul", "Istanbul", ["turkey"])
        add("Europe/Moscow", "Moscow", ["msk"])
        add("Asia/Riyadh", "Riyadh", ["saudi", "saudi arabia", "jeddah"])
        add("Asia/Jerusalem", "Jerusalem", ["israel", "tel aviv"])
        return m
    }()

    /// Last parts of identifiers that are ordinary words, not places anyone types.
    static let skip: Set<String> = ["center", "central", "eastern", "western", "general", "north", "south", "east", "west", "knox", "salem"]

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cities: [String: Place]?

    /// "tokyo" -> Asia/Tokyo, "new york" -> America/New_York, "asia/tokyo" -> Asia/Tokyo.
    static func identifierPlaces() -> [String: Place] {
        lock.lock(); defer { lock.unlock() }
        if let c = cities { return c }
        var m: [String: Place] = [:]
        for id in TimeZone.knownTimeZoneIdentifiers {
            m[id.lowercased()] = Place(id: id, name: id)
            guard id.contains("/"), let last = id.split(separator: "/").last else { continue }
            let name = last.replacingOccurrences(of: "_", with: " ")
            let key = name.lowercased()
            if skip.contains(key) || m[key] != nil { continue }
            m[key] = Place(id: id, name: name)
        }
        cities = m
        return m
    }

    static func place(_ s: String) -> (Place, TimeZone)? {
        let k = s.trimmingCharacters(in: .whitespaces)
        if k.isEmpty { return nil }
        if let p = extra[k] ?? identifierPlaces()[k], let tz = zone(p.id) { return (p, tz) }
        // An identifier macOS knows under an older name ("Asia/Kolkata" is listed as Asia/Calcutta).
        if k.contains("/") {
            let id = k.split(separator: "/").map { $0.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: "_") }
                .joined(separator: "/")
            if let tz = zone(id) { return (Place(id: id, name: id), tz) }
        }
        return nil
    }

    /// "3pm", "3 pm", "3:30pm", "15:00", "noon", "midnight" -> hour and minute. Nil for "3".
    static func clock(_ s: String) -> (Int, Int)? {
        if s == "noon" { return (12, 0) }
        if s == "midnight" { return (0, 0) }
        var body = s.replacingOccurrences(of: " ", with: "")
        var mer: String?
        for m in ["am", "pm", "a.m.", "p.m."] where body.hasSuffix(m) { mer = String(m.prefix(1)); body = String(body.dropLast(m.count)); break }
        let parts = body.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0.count <= 2 && $0.allSatisfy(\.isNumber) }),
              var h = Int(parts[0]) else { return nil }
        let m = parts.count == 2 ? Int(parts[1]) ?? -1 : 0
        if parts.count == 2 && parts[1].count != 2 { return nil }
        guard m >= 0 && m < 60 else { return nil }
        if let mer {
            guard h >= 1 && h <= 12 else { return nil }
            if mer == "a" && h == 12 { h = 0 } else if mer == "p" && h != 12 { h += 12 }
        } else {
            guard parts.count == 2, h <= 23 else { return nil }
        }
        return (h, m)
    }

    /// Splits "3pm london" / "10:30 pst" into the clock and the rest, trying the longest clock first.
    static func splitClock(_ s: String) -> ((Int, Int), String)? {
        let w = s.split(separator: " ").map(String.init)
        for n in stride(from: min(2, w.count), through: 1, by: -1) {
            if let c = clock(w[0..<n].joined(separator: " ")) { return (c, w[n...].joined(separator: " ")) }
        }
        return nil
    }

    static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    nonisolated(unsafe) private static var zones: [String: TimeZone] = [:]
    nonisolated(unsafe) private static var calendars: [String: Calendar] = [:]

    /// TimeZone and Calendar are costly to make on every keystroke; a handful are kept.
    static func zone(_ id: String) -> TimeZone? {
        lock.lock(); defer { lock.unlock() }
        if let z = zones[id] { return z }
        guard let z = TimeZone(identifier: id) else { return nil }
        if zones.count > 64 { zones.removeAll() }
        zones[id] = z
        return z
    }

    static func calendar(_ tz: TimeZone) -> Calendar {
        lock.lock(); defer { lock.unlock() }
        if let c = calendars[tz.identifier] { return c }
        var c = Calendar(identifier: .gregorian); c.timeZone = tz
        if calendars.count > 64 { calendars.removeAll() }
        calendars[tz.identifier] = c
        return c
    }

    static func hm(_ d: Date, _ tz: TimeZone, _ use24h: Bool) -> String {
        let c = calendar(tz).dateComponents([.hour, .minute], from: d)
        let h = c.hour ?? 0, m = c.minute ?? 0
        if use24h { return String(format: "%02d:%02d", h, m) }
        return String(format: "%d:%02d %@", h % 12 == 0 ? 12 : h % 12, m, h < 12 ? "AM" : "PM")
    }

    static func day(_ d: Date, _ tz: TimeZone) -> String {
        let c = calendar(tz).dateComponents([.weekday, .day, .month], from: d)
        return "\(weekdays[(c.weekday ?? 1) - 1]) \(c.day ?? 1) \(months[(c.month ?? 1) - 1])"
    }

    /// "UTC+9", "UTC+5:30", "UTC-7", "UTC".
    static func offset(_ secs: Int) -> String {
        if secs == 0 { return "UTC" }
        let a = abs(secs), h = a / 3600, m = (a % 3600) / 60
        return "UTC" + (secs < 0 ? "-" : "+") + "\(h)" + (m == 0 ? "" : String(format: ":%02d", m))
    }

    /// "9 h ahead", "5 h 30 min behind", "same time as here".
    static func relative(_ secs: Int) -> String {
        if secs == 0 { return "same time as here" }
        let a = abs(secs), h = a / 3600, m = (a % 3600) / 60
        let span = h == 0 ? "\(m) min" : m == 0 ? "\(h) h" : "\(h) h \(m) min"
        return span + (secs > 0 ? " ahead" : " behind")
    }

    static func current(_ place: String) -> String? {
        for p in ["what time is it in ", "what's the time in ", "whats the time in ", "current time in ", "time now in ", "time in "]
        where place.hasPrefix(p) { return String(place.dropFirst(p.count)) }
        for s in [" time now", " time"] where place.hasSuffix(s) { return String(place.dropLast(s.count)) }
        return nil
    }

    /// The answer for this text, or nil when it is not clearly a time question.
    public static func evaluate(_ text: String, now: Date = Date(), local: TimeZone = .current, use24h: Bool = false) -> TimeAnswer? {
        var q = Query(text).normalized
        while q.hasSuffix("?") { q.removeLast() }
        q = q.trimmingCharacters(in: .whitespaces)
        if q.isEmpty || q.count > 60 { return nil }

        // What time is it there now.
        if let where_ = current(q), let (p, tz) = place(where_) {
            let label = hm(now, tz, use24h)
            let off = tz.secondsFromGMT(for: now), here = local.secondsFromGMT(for: now)
            let sub = "\(p.name) · \(day(now, tz)) · \(offset(off)) · \(relative(off - here))"
            return TimeAnswer(id: "time:\(p.id)", label: label, sub: sub, copy: label, zone: p.id)
        }

        // A clock in one zone, shown in another.
        guard let ((h, m), rest) = splitClock(q), !rest.isEmpty else { return nil }
        var fromText = rest, toText: String?
        let w = rest.split(separator: " ").map(String.init)
        if let i = w.firstIndex(where: { ["in", "to", "into", "as"].contains($0) }) {
            fromText = w[..<i].joined(separator: " ")
            toText = w[(i + 1)...].joined(separator: " ")
            if toText!.isEmpty { return nil }
        }
        let src: (Place, TimeZone)
        if fromText.isEmpty { src = (Place(id: local.identifier, name: "here"), local) }
        else { guard let s = place(fromText) else { return nil }; src = s }
        let dst: (Place, TimeZone)
        if let toText { guard let d = place(toText) else { return nil }; dst = d }
        else { dst = (Place(id: local.identifier, name: "here"), local) }
        if src.1.identifier == dst.1.identifier && (fromText.isEmpty || toText == nil) { return nil }

        // That clock on today's date where it is read.
        let cal = calendar(src.1)
        var c = cal.dateComponents([.year, .month, .day], from: now)
        c.hour = h; c.minute = m
        guard let at = cal.date(from: c) else { return nil }
        let label0 = hm(at, dst.1, use24h)
        let dayFrom = cal.dateComponents([.year, .month, .day], from: at)
        let dayTo = calendar(dst.1).dateComponents([.year, .month, .day], from: at)
        var label = label0
        if dayFrom != dayTo {
            let later = (dayTo.year!, dayTo.month!, dayTo.day!) > (dayFrom.year!, dayFrom.month!, dayFrom.day!)
            label += later ? " (next day)" : " (previous day)"
        }
        let srcName = src.0.name == "here" ? "here" : "in \(src.0.name)"
        let dstName = dst.0.name == "here" ? "here" : "in \(dst.0.name)"
        let sub = "\(hm(at, src.1, use24h)) \(srcName) is \(label0) \(dstName) · \(offset(dst.1.secondsFromGMT(for: at)))"
        return TimeAnswer(id: "time:\(String(format: "%02d%02d", h, m)):\(src.1.identifier):\(dst.1.identifier)",
                          label: label, sub: sub, copy: label0, zone: dst.1.identifier)
    }
}

/// A time row: Enter copies the time (the app wires the action from copyText).
public func timeResult(_ q: Query, now: Date = Date(), local: TimeZone = .current, use24h: Bool = false) -> ResultItem? {
    guard let a = TimeZones.evaluate(q.text, now: now, local: local, use24h: use24h) else { return nil }
    return ResultItem(id: a.id, kind: "time", title: a.label, subtitle: a.sub, icon: .symbol("clock", .signal),
                      section: .answer, score: 1, copyText: a.copy, payload: ["copy": a.copy, "zone": a.zone])
}
