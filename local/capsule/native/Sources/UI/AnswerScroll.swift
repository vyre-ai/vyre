// AnswerScroll: the answer card grows with its words up to the room it has, then scrolls.
//
// The card never clips a line away with no way to reach it. It scrolls with the trackpad, and
// with ⌘↑ ⌘↓, PageUp PageDown, Home and End while the focus stays in the box (Host/Panel.swift
// sends those keys here). While an answer streams it follows the newest words, unless the user
// scrolled up; scrolling back to the end follows again.
//
// SwiftUI's ScrollView on macOS 14 cannot scroll by a page from code, so a probe inside it finds
// the NSScrollView it is drawn in and the scrolling is AppKit's.

import AppKit
import SwiftUI

@MainActor final class AnswerScroller: ObservableObject {
    private(set) weak var scrollView: NSScrollView?
    /// Keep the newest words in sight. Off once the user scrolls away from the end.
    @Published private(set) var following = true
    /// The thumb, as fractions of the card (start, length), while there is anything to scroll.
    @Published private(set) var thumb: (start: CGFloat, length: CGFloat)?
    private var watching: NSObjectProtocol?
    /// Our own scrolls, so a bounds change from them is not read as the user's.
    private var moving = false

    func attach(_ s: NSScrollView) {
        guard s !== scrollView else { return }
        if let w = watching { NotificationCenter.default.removeObserver(w) }
        scrollView = s
        // The card draws its own thumb (always shown while it can scroll); AppKit's hides.
        s.hasVerticalScroller = false
        s.contentView.postsBoundsChangedNotifications = true
        watching = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: s.contentView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.userScrolled() }
        }
    }

    /// A new answer: follow it from the top of its stream.
    func reset() { following = true; scroll(to: 0) }

    /// Whether the words run past the card, so there is anything to scroll.
    var overflows: Bool {
        guard let s = scrollView, let doc = s.documentView else { return false }
        return doc.frame.height > s.contentView.bounds.height + 0.5
    }

    var atEnd: Bool {
        guard let s = scrollView, let doc = s.documentView else { return true }
        return s.contentView.bounds.maxY >= doc.frame.height - 4 || !overflows
    }

    var offset: CGFloat { scrollView?.contentView.bounds.origin.y ?? 0 }

    private var maxOffset: CGFloat {
        guard let s = scrollView, let doc = s.documentView else { return 0 }
        return max(0, doc.frame.height - s.contentView.bounds.height)
    }

    /// The words grew: keep the end in sight if following. Run after layout.
    func grew() { if following { scroll(to: maxOffset) } else { measure() } }

    /// ⌥↑ ⌥↓: three lines.
    func lines(_ by: Int) { scroll(to: offset + CGFloat(by) * 3 * Theme.readLine) }

    /// One page up (-1) or down (1), keeping a line of the last page for context.
    func page(_ by: Int) {
        guard let s = scrollView else { return }
        let step = max(40, s.contentView.bounds.height - 40)
        scroll(to: offset + CGFloat(by) * step)
    }

    func toTop() { scroll(to: 0) }
    func toEnd() { scroll(to: maxOffset) }

    private func scroll(to y: CGFloat) {
        guard let s = scrollView else { return }
        let y = min(max(0, y), maxOffset)
        moving = true
        s.contentView.scroll(to: NSPoint(x: 0, y: y))
        s.reflectScrolledClipView(s.contentView)
        moving = false
        measure()
    }

    private func userScrolled() {
        guard !moving else { return }
        measure()
    }

    /// Follow and the thumb from where the card is now. Published only when they change.
    private func measure() {
        if following != atEnd { following = atEnd }
        var t: (start: CGFloat, length: CGFloat)?
        if overflows, let s = scrollView, let doc = s.documentView, doc.frame.height > 0 {
            let h = s.contentView.bounds.height
            t = (offset / doc.frame.height, h / doc.frame.height)
        }
        if t?.start != thumb?.start || t?.length != thumb?.length { thumb = t }
    }
}

/// Finds the NSScrollView the answer is drawn in and hands it to the scroller.
struct ScrollProbe: NSViewRepresentable {
    let scroller: AnswerScroller

    final class Probe: NSView {
        var found: ((NSScrollView) -> Void)?
        override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); look() }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); look() }
        override func layout() { super.layout(); look() }
        func look() { if let s = enclosingScrollView { found?(s) } }
    }

    func makeNSView(context: Context) -> Probe {
        let p = Probe()
        p.found = { [weak scroller] s in MainActor.assumeIsolated { scroller?.attach(s) } }
        return p
    }

    func updateNSView(_ p: Probe, context: Context) { p.look() }
}

/// The answer's full height, measured inside its scroll view.
struct AnswerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The answer in a card that is as tall as its words, up to `cap`, and scrolls past that.
struct AnswerScroll<Content: View>: View {
    let scroller: AnswerScroller
    let cap: CGFloat
    /// Changes whenever the words grow (the revealed count), so the card follows the stream.
    let grows: Int
    /// Changes with a new answer (its thread), which starts again at the top.
    let answerID: String
    @ViewBuilder let content: () -> Content
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            content()
                .background(ScrollProbe(scroller: scroller).frame(width: 0, height: 0))
                .background(GeometryReader { g in Color.clear.preference(key: AnswerHeightKey.self, value: g.size.height) })
        }
        .frame(height: CapsuleLayout.answerHeight(content: height, cap: cap), alignment: .top)
        .overlay { AnswerChrome(scroller: scroller) }
        .onPreferenceChange(AnswerHeightKey.self) { h in
            height = h
            DispatchQueue.main.async { scroller.grew() }
        }
        .onChange(of: grows) { DispatchQueue.main.async { scroller.grew() } }
        .onChange(of: answerID) { scroller.reset() }
    }
}

/// What the card draws over itself while it scrolls: a 4 wide thumb 3 in from the right edge, and
/// "Jump to latest ⌘↓" at its bottom edge once the user has scrolled up from a longer answer.
struct AnswerChrome: View {
    @ObservedObject var scroller: AnswerScroller

    var body: some View {
        GeometryReader { g in
            if let t = scroller.thumb {
                Capsule().fill(Theme.ruleStrong)
                    .frame(width: 4, height: max(24, g.size.height * t.length))
                    .offset(x: g.size.width - 4 - 3, y: min(g.size.height - max(24, g.size.height * t.length), g.size.height * t.start))
                    .allowsHitTesting(false)
            }
            if scroller.thumb != nil && !scroller.following {
                KeyHint(title: "Jump to latest", keys: ["⌘", "↓"])
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Capsule().fill(Theme.raised))
                    .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 8)
                    .onTapGesture { scroller.toEnd() }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Command Down Arrow")
            }
        }
    }
}
