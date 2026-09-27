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

@MainActor final class AnswerScroller {
    private(set) weak var scrollView: NSScrollView?
    /// Keep the newest words in sight. Off once the user scrolls away from the end.
    private(set) var following = true
    private var watching: NSObjectProtocol?
    /// Our own scrolls, so a bounds change from them is not read as the user's.
    private var moving = false

    func attach(_ s: NSScrollView) {
        guard s !== scrollView else { return }
        if let w = watching { NotificationCenter.default.removeObserver(w) }
        scrollView = s
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
    func grew() { if following { scroll(to: maxOffset) } }

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
        following = atEnd
    }

    private func userScrolled() {
        guard !moving else { return }
        following = atEnd
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
        ScrollView(.vertical, showsIndicators: true) {
            content()
                .background(ScrollProbe(scroller: scroller).frame(width: 0, height: 0))
                .background(GeometryReader { g in Color.clear.preference(key: AnswerHeightKey.self, value: g.size.height) })
        }
        .scrollIndicators(.automatic)
        .frame(height: CapsuleLayout.answerHeight(content: height, cap: cap), alignment: .top)
        .onPreferenceChange(AnswerHeightKey.self) { h in
            height = h
            DispatchQueue.main.async { scroller.grew() }
        }
        .onChange(of: grows) { DispatchQueue.main.async { scroller.grew() } }
        .onChange(of: answerID) { scroller.reset() }
    }
}
