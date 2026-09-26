import SwiftUI

/// The Lead mark's wire on the 24 grid: one wire bent into a v, the right arm stopping short.
struct MarkWire: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let o = CGPoint(x: rect.midX - 12 * s, y: rect.midY - 12 * s)
        var p = Path()
        p.move(to: CGPoint(x: o.x + 3.5 * s, y: o.y + 5.5 * s))
        p.addLine(to: CGPoint(x: o.x + 12 * s, y: o.y + 19.5 * s))
        p.addLine(to: CGPoint(x: o.x + 17.96 * s, y: o.y + 9.69 * s))
        return p
    }
}

/// The dot at the end of the right arm.
struct MarkDot: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let o = CGPoint(x: rect.midX - 12 * s, y: rect.midY - 12 * s)
        let r = 2.3 * s
        return Path(ellipseIn: CGRect(x: o.x + 20.5 * s - r, y: o.y + 5.5 * s - r, width: 2 * r, height: 2 * r))
    }
}

/// The mark: Bone wire, Signal dot on dark; Ink and Ink on paper; the dot turns Beacon when
/// something needs the person.
struct Mark: View {
    var size: CGFloat = 20
    var needsYou = false
    var body: some View {
        ZStack {
            MarkWire().stroke(Color.bone, style: StrokeStyle(lineWidth: 2.4 * size / 24, lineCap: .round, lineJoin: .round))
            MarkDot().fill(needsYou ? Color.beaconDot : Color.markDot)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The wordmark "vyre", monoline, drawn in the mark's wire. viewBox -2 3 62 26.
struct Wordmark: View {
    var height: CGFloat = 22
    var body: some View {
        WordmarkShape()
            .stroke(Color.bone, style: StrokeStyle(lineWidth: 2.6 * height / 26, lineCap: .round, lineJoin: .round))
            .frame(width: height * 62 / 26, height: height)
            .accessibilityLabel("vyre")
    }
}

struct WordmarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.height / 26
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + (x + 2) * s, y: rect.minY + (y - 3) * s) }
        var p = Path()
        p.move(to: pt(0, 6)); p.addLine(to: pt(6, 20)); p.addLine(to: pt(12, 6))
        p.move(to: pt(16, 6)); p.addLine(to: pt(22, 20))
        p.move(to: pt(28, 6)); p.addLine(to: pt(19.4, 26))
        p.move(to: pt(33, 6)); p.addLine(to: pt(33, 20))
        p.move(to: pt(33, 13)); p.addQuadCurve(to: pt(40, 6), control: pt(33, 6))
        p.move(to: pt(43, 13)); p.addLine(to: pt(57, 13))
        // A7 7 0 1 0 55.36 17.5 from (57,13): the large arc of the e, centre (50,13).
        let c = pt(50, 13)
        let start = Angle.degrees(0)
        let end = Angle(radians: atan2(Double(17.5 - 13), Double(55.36 - 50)))
        // SwiftUI's clockwise flag is flipped in a y-down space: true draws the long way round, as sweep 0 does.
        p.addArc(center: c, radius: 7 * s, startAngle: start, endAngle: end, clockwise: true)
        return p
    }
}
