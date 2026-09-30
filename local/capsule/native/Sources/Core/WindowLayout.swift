// WindowLayout: where a window goes for "left half", "maximize", "next display" and the rest.
// Pure geometry, no windows touched: Providers/WindowsProvider.swift moves them.
//
// Two coordinate systems meet here. AppKit (NSScreen) has its origin at the bottom left of the
// main display, y up. The accessibility API (a window's position) has its origin at the top left
// of the main display, y down. Layouts are worked out in AppKit coordinates against a screen's
// visible frame (no menu bar or Dock) and converted at the edge.

import CoreGraphics
import Foundation

public enum WindowLayout: String, CaseIterable, Sendable {
    case leftHalf, rightHalf, topHalf, bottomHalf
    case topLeft, topRight, bottomLeft, bottomRight
    case leftThird, centerThird, rightThird, leftTwoThirds, rightTwoThirds
    case maximize, almostMaximize, center
    case nextDisplay, previousDisplay
    case restore

    public var title: String {
        switch self {
        case .leftHalf: return "Left Half"
        case .rightHalf: return "Right Half"
        case .topHalf: return "Top Half"
        case .bottomHalf: return "Bottom Half"
        case .topLeft: return "Top Left"
        case .topRight: return "Top Right"
        case .bottomLeft: return "Bottom Left"
        case .bottomRight: return "Bottom Right"
        case .leftThird: return "Left Third"
        case .centerThird: return "Center Third"
        case .rightThird: return "Right Third"
        case .leftTwoThirds: return "Left Two Thirds"
        case .rightTwoThirds: return "Right Two Thirds"
        case .maximize: return "Maximize"
        case .almostMaximize: return "Almost Maximize"
        case .center: return "Center"
        case .nextDisplay: return "Next Display"
        case .previousDisplay: return "Previous Display"
        case .restore: return "Restore"
        }
    }

    public var keywords: [String] {
        switch self {
        case .leftHalf: return ["snap left", "window left", "half left"]
        case .rightHalf: return ["snap right", "window right", "half right"]
        case .topHalf: return ["snap top", "window top", "half top"]
        case .bottomHalf: return ["snap bottom", "window bottom", "half bottom"]
        case .topLeft: return ["upper left", "quarter top left"]
        case .topRight: return ["upper right", "quarter top right"]
        case .bottomLeft: return ["lower left", "quarter bottom left"]
        case .bottomRight: return ["lower right", "quarter bottom right"]
        case .leftThird: return ["first third"]
        case .centerThird: return ["middle third"]
        case .rightThird: return ["last third"]
        case .leftTwoThirds: return ["first two thirds"]
        case .rightTwoThirds: return ["last two thirds"]
        case .maximize: return ["full", "fullscreen", "full screen", "fill", "max", "window max"]
        case .almostMaximize: return ["almost full", "nearly full"]
        case .center: return ["middle", "window center", "centre"]
        case .nextDisplay: return ["next screen", "move to next display", "other display", "next monitor"]
        case .previousDisplay: return ["previous screen", "move to previous display", "last display", "previous monitor"]
        case .restore: return ["undo window", "previous size", "original size", "put back"]
        }
    }

    public var symbol: String {
        switch self {
        case .leftHalf, .leftThird, .leftTwoThirds: return "rectangle.lefthalf.inset.filled"
        case .rightHalf, .rightThird, .rightTwoThirds: return "rectangle.righthalf.inset.filled"
        case .topHalf: return "rectangle.tophalf.inset.filled"
        case .bottomHalf: return "rectangle.bottomhalf.inset.filled"
        case .topLeft, .topRight, .bottomLeft, .bottomRight: return "rectangle.inset.topleft.filled"
        case .centerThird, .center: return "rectangle.center.inset.filled"
        case .maximize, .almostMaximize: return "rectangle.inset.filled"
        case .nextDisplay, .previousDisplay: return "display.2"
        case .restore: return "arrow.uturn.backward"
        }
    }

    /// The window's new frame in AppKit coordinates within `v` (the screen's visible frame), or nil
    /// for the layouts that are not a place on one screen (display moves, restore). `current` is the
    /// window now, for Center, which keeps its size.
    public func frame(in v: CGRect, current: CGRect? = nil) -> CGRect? {
        let w = v.width, h = v.height
        func r(_ x: CGFloat, _ y: CGFloat, _ ww: CGFloat, _ hh: CGFloat) -> CGRect {
            CGRect(x: (v.minX + x).rounded(), y: (v.minY + y).rounded(), width: ww.rounded(), height: hh.rounded())
        }
        switch self {
        case .leftHalf: return r(0, 0, w / 2, h)
        case .rightHalf: return r(w / 2, 0, w - (w / 2).rounded(), h)
        case .topHalf: return r(0, h / 2, w, h - (h / 2).rounded())
        case .bottomHalf: return r(0, 0, w, h / 2)
        case .topLeft: return r(0, h / 2, w / 2, h - (h / 2).rounded())
        case .topRight: return r(w / 2, h / 2, w - (w / 2).rounded(), h - (h / 2).rounded())
        case .bottomLeft: return r(0, 0, w / 2, h / 2)
        case .bottomRight: return r(w / 2, 0, w - (w / 2).rounded(), h / 2)
        case .leftThird: return r(0, 0, w / 3, h)
        case .centerThird: return r(w / 3, 0, w / 3, h)
        case .rightThird: return r(w * 2 / 3, 0, w - (w * 2 / 3).rounded(), h)
        case .leftTwoThirds: return r(0, 0, w * 2 / 3, h)
        case .rightTwoThirds: return r(w / 3, 0, w - (w / 3).rounded(), h)
        case .maximize: return r(0, 0, w, h)
        case .almostMaximize: return r(w * 0.05, h * 0.05, w * 0.9, h * 0.9)
        case .center:
            guard let c = current else { return nil }
            let cw = min(c.width, w), ch = min(c.height, h)
            return r((w - cw) / 2, (h - ch) / 2, cw, ch)
        case .nextDisplay, .previousDisplay, .restore: return nil
        }
    }

    // MARK: screens and coordinates

    /// The screen (by index into `screens`, visible frames in AppKit coordinates) a window mostly
    /// sits on: the one with the largest overlap, else the one nearest its centre.
    public static func screenIndex(of window: CGRect, in screens: [CGRect]) -> Int? {
        guard !screens.isEmpty else { return nil }
        let overlaps = screens.map { let i = $0.intersection(window); return i.isNull ? 0 : i.width * i.height }
        if let best = overlaps.enumerated().max(by: { $0.element < $1.element }), best.element > 0 { return best.offset }
        let c = CGPoint(x: window.midX, y: window.midY)
        return screens.enumerated().min { dist($0.element, c) < dist($1.element, c) }?.offset
    }

    private static func dist(_ r: CGRect, _ p: CGPoint) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX), dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return dx * dx + dy * dy
    }

    /// The window moved to another screen, keeping its place and size in proportion to it. The
    /// result never sticks out of `to`.
    public static func move(_ w: CGRect, from: CGRect, to: CGRect) -> CGRect {
        guard from.width > 0, from.height > 0 else { return w }
        let sx = to.width / from.width, sy = to.height / from.height
        let nw = min(w.width * sx, to.width).rounded(), nh = min(w.height * sy, to.height).rounded()
        var x = to.minX + (w.minX - from.minX) * sx, y = to.minY + (w.minY - from.minY) * sy
        x = min(max(x, to.minX), to.maxX - nw); y = min(max(y, to.minY), to.maxY - nh)
        return CGRect(x: x.rounded(), y: y.rounded(), width: nw, height: nh)
    }

    /// AppKit frame (bottom-left origin) to accessibility frame (top-left origin), given the main
    /// display's height. The conversion is its own inverse.
    public static func flip(_ r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }
}
