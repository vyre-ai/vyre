// AgentDesk: the waiting list and the card that answers one item, drawn from Desk.
//
// Attention (violet) for anything held or asking, quiet for a proposed lesson. The list is oldest first. A
// mail draft is edited in place and ⌘⏎ sends exactly what the card shows; an ask or a lesson is a
// yes or a no. Keys are the panel's (Agent/AgentPanelKeys.swift); this view only draws.

import SwiftUI

struct WaitingList: View {
    @ObservedObject var desk: Desk
    /// How many rows to draw: the whole list, or the compact panel's few (none highlighted).
    var limit = Theme.maxRows

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Needs you · \(desk.waiting.count)").font(Theme.label).foregroundColor(Theme.attention)
                Spacer()
                Text("oldest first").font(Theme.subtitle).foregroundColor(Theme.ash)
            }
            .padding(.horizontal, Theme.inset).frame(height: Theme.headerHeight, alignment: .bottom)
            ForEach(Array(desk.waiting.prefix(limit).enumerated()), id: \.element.key) { i, w in
                WaitingRow(w: w, selected: desk.highlighted?.key == w.key)
                    .contentShape(Rectangle())
                    .onTapGesture { desk.openCard(w) }
                    .accessibilityIdentifier("waiting-\(i)")
            }
            // The keys are in the panel's footer (CapsuleLayout.footerHints).
        }
    }

}

struct WaitingRow: View {
    let w: Waiting
    let selected: Bool
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(w.quiet ? Theme.ash : Theme.attention).frame(width: 7, height: 7).frame(width: Theme.iconSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(w.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                if !w.sub.isEmpty { Text(w.sub).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1) }
            }
            Spacer(minLength: 8)
            Text(w.age()).font(Theme.subtitle).foregroundColor(Theme.ash)
            if selected { Image(systemName: "return").font(Theme.subtitle).foregroundColor(Theme.ash) }
        }
        .padding(.horizontal, Theme.inset)
        .frame(height: Theme.rowHeight)
        .background(selected ? Theme.raised : Color.clear)
        .overlay(alignment: .leading) { if selected { Rectangle().fill(Theme.attention).frame(width: 2) } }
    }
}

/// One item's card. A mail draft is three editable lines; anything else is shown as it is.
struct HeldCardView: View {
    @ObservedObject var desk: Desk
    let w: Waiting

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(w.source == .lesson ? "Vyre proposes" : "Held for you").font(Theme.label)
                    .foregroundColor(w.source == .lesson ? Theme.ash : Theme.attention)
                Text(w.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
            }
            content
            HStack(spacing: 10) {
                Button { Task { await desk.yes(w) } } label: { Text(yesTitle + (w.source == .gate ? "  ⌘⏎" : "  ⏎")) }
                    .buttonStyle(AgentButton(primary: true)).disabled(desk.busy || desk.loading)
                Button { Task { await desk.no(w) } } label: { Text(noTitle) }
                    .buttonStyle(AgentButton(primary: false)).disabled(desk.busy)
                if let r = w.source == .lesson ? nil : (w.rule.map { "Rule: \($0)" } ?? w.why) {
                    Text(r).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
                }
                Spacer()
            }
            if let n = desk.note, !n.isEmpty { Text(n).font(Theme.subtitle).foregroundColor(Theme.bone).lineLimit(3) }
        }
        .padding(.horizontal, Theme.inset).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var yesTitle: String { w.source == .lesson ? "Accept" : w.source == .ask ? "Allow" : "Send" }
    private var noTitle: String { w.source == .lesson ? "Decline" : w.source == .ask ? "Deny" : "Discard" }

    @ViewBuilder private var content: some View {
        if w.source == .gate, desk.held?.draft != nil {
            grid("To") { TextField("", text: $desk.draft.to).textFieldStyle(.plain).font(Theme.mono).foregroundColor(Theme.bone) }
            grid("Subject") { TextField("", text: $desk.draft.subject).textFieldStyle(.plain).font(Theme.title).foregroundColor(Theme.bone) }
            TextEditor(text: $desk.draft.body).font(Theme.title).foregroundColor(Theme.bone)
                .scrollContentBackground(.hidden).frame(height: HeldCardView.bodyHeight)
                .background(RoundedRectangle(cornerRadius: Tokens.Radius.field).fill(Theme.raised))
            Text("Click any line to change it. ⌘⏎ sends what you see. Esc goes back.").font(Theme.subtitle).foregroundColor(Theme.ash)
        } else if w.source == .gate && desk.loading {
            Text("Opening the draft…").font(Theme.subtitle).foregroundColor(Theme.ash)
        } else if w.source == .gate {
            if let to = w.to, !to.isEmpty { grid("To") { Text(to).font(Theme.mono).foregroundColor(Theme.bone) } }
            if let via = w.via { grid("Via") { Text(via).font(Theme.mono).foregroundColor(Theme.bone) } }
            if let s = desk.held?.summary, !s.isEmpty { Text(s).font(Theme.title).foregroundColor(Theme.stone).lineLimit(4) }
        } else if w.source == .lesson, let card = w.lesson {
            Text(card.rule).font(Theme.title).foregroundColor(Theme.bone).lineLimit(4)
            ForEach(card.lines, id: \.label) { l in grid(l.label) { Text(l.text).font(Theme.subtitle).foregroundColor(Theme.stone) } }
        } else {
            if let t = w.tool { grid("Tool") { Text(t).font(Theme.mono).foregroundColor(Theme.bone) } }
            if !w.sub.isEmpty { grid("Where") { Text(w.sub).font(Theme.subtitle).foregroundColor(Theme.stone) } }
        }
    }

    private func grid<V: View>(_ k: String, @ViewBuilder _ v: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(k).font(Theme.label).foregroundColor(Theme.ash).frame(width: 64, alignment: .leading)
            v()
            Spacer(minLength: 0)
        }
    }

    static let bodyHeight: CGFloat = 150

}

struct AgentButton: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.subtitle)
            .foregroundColor(primary ? Theme.graphite : Theme.bone)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: Tokens.Radius.button).fill(primary ? Theme.bone : Theme.raised).opacity(configuration.isPressed ? 0.8 : 1))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.button).strokeBorder(primary ? Color.clear : Theme.ruleStrong, lineWidth: 1))
    }
}

/// Where the agent views sit in the panel's fixed area (CapsuleLayout in CapsuleView.swift).
@MainActor enum AgentLayout {
    /// The list or a card takes the whole area while it is open.
    static func deskShown(_ m: CapsuleModel) -> Bool { m.desk.mode != .none || m.actionMenu.isOpen }
    /// The conversation with the agent in the chip, above its destination rows.
    static func directShown(_ m: CapsuleModel) -> Bool { m.desk.mode == .none && m.direct.dm != nil && m.asked == nil }
    static func hintShown(_ m: CapsuleModel) -> Bool {
        m.desk.mode == .none && m.text.isEmpty && m.target == nil && m.asked == nil && !m.desk.waiting.isEmpty
    }
    /// Whether the agent half needs the area open.
    static func opens(_ m: CapsuleModel) -> Bool { deskShown(m) || directShown(m) }
    /// The rows of the waiting list the compact panel shows under an empty box.
    static let compactRows = 3
    /// The compact panel's agent half: the offline line, then the first few rows that wait.
    static func compactHeight(_ m: CapsuleModel) -> CGFloat {
        (m.offline ? OfflineBanner.height : 0)
            + (nextMeetingShown(m) ? CapsuleLayout.lineHeight : 0)
            + (m.loosenedShown ? CapsuleLayout.lineHeight : 0)
            + (hintShown(m) ? Theme.headerHeight + CGFloat(min(m.desk.waiting.count, compactRows)) * Theme.rowHeight : 0)
    }

    @ViewBuilder static func desk(_ m: CapsuleModel) -> some View {
        if m.actionMenu.isOpen { ActionMenuView(menu: m.actionMenu) } else {
        switch m.desk.mode {
        case .none: EmptyView()
        case .list: ScrollView(.vertical, showsIndicators: false) { WaitingList(desk: m.desk) }
        case .card: if let w = m.desk.open { ScrollView(.vertical, showsIndicators: false) { HeldCardView(desk: m.desk, w: w) } }
        }
        }
    }

    /// Above the rows in the area: offline, then the conversation.
    @ViewBuilder static func above(_ m: CapsuleModel) -> some View {
        if m.offline { OfflineBanner(model: m); Rule() }
        if directShown(m) { DirectView(direct: m.direct, desk: m.desk, who: m.identities, assistant: m.catalog.assistant?.name); Rule() }
    }

    /// The next-meeting line shows under an empty box, once there is one.
    static func nextMeetingShown(_ m: CapsuleModel) -> Bool { m.text.isEmpty && !(m.nextMeeting ?? "").isEmpty }

    /// Under the bar in the compact panel: offline, the next meeting, then what waits (compactHeight).
    @ViewBuilder static func compact(_ m: CapsuleModel) -> some View {
        if m.offline { OfflineBanner(model: m) }
        if m.loosenedShown, let n = m.loosened {
            HStack(spacing: 8) {
                Image(systemName: "arrow.uturn.backward.circle").font(Theme.subtitle).foregroundColor(Theme.ash)
                Text(n.words).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Button { Task { await m.undoLoosened() } } label: { KeyHint(title: "Undo", keys: ["\u{23CE}"]) }.buttonStyle(.plain)
            }
            .padding(.horizontal, Theme.inset).frame(height: CapsuleLayout.lineHeight)
            .accessibilityLabel("\(n.words) Undo")
        }
        if nextMeetingShown(m), let line = m.nextMeeting {
            HStack(spacing: 8) {
                Image(systemName: "calendar").font(Theme.subtitle).foregroundColor(Theme.ash)
                Text(line).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.inset).frame(height: CapsuleLayout.lineHeight)
            .accessibilityLabel("Next meeting: \(line)")
        }
        if hintShown(m) { WaitingList(desk: m.desk, limit: compactRows) }
    }
}

/// vyred is not running: nothing can be sent, and results here are from this Mac. The line is
/// the way out: "Start Vyre" (Return on an empty box, or a click) runs `vyre up` from here.
struct OfflineBanner: View {
    @ObservedObject var model: CapsuleModel
    var body: some View {
        HStack(spacing: 8) {
            Text("Offline").font(Theme.label).foregroundColor(Theme.ash)
            Text(model.startingVyre ? "Starting Vyre on this Mac…" : "vyred is not running on this Mac. Results here are from this Mac.")
                .font(Theme.subtitle).foregroundColor(Theme.bone).lineLimit(1)
            Spacer()
            if model.startingVyre {
                ProgressView().controlSize(.small).scaleEffect(0.7)
            } else {
                Button { model.startVyre() } label: { KeyHint(title: "Start Vyre", keys: ["⏎"]) }
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Theme.inset).frame(height: OfflineBanner.height)
    }
    static let height: CGFloat = CapsuleLayout.lineHeight
}

/// The ⌘K list: the row, then its verbs.
struct ActionMenuView: View {
    @ObservedObject var menu: ActionMenu
    var body: some View {
        if let r = menu.item {
            VStack(alignment: .leading, spacing: 0) {
                Text(r.title).font(Theme.label).foregroundColor(Theme.ash).lineLimit(1)
                    .padding(.horizontal, Theme.inset).frame(height: Theme.headerHeight, alignment: .bottomLeading)
                ForEach(Array(r.actions.enumerated()), id: \.offset) { i, a in
                    HStack(spacing: 10) {
                        Image(systemName: a.symbol).font(Theme.title).foregroundColor(Theme.stone).frame(width: Theme.iconSize)
                        Text(a.title).font(Theme.title).foregroundColor(Theme.bone)
                        Spacer()
                        if i == menu.index { Image(systemName: "return").font(Theme.subtitle).foregroundColor(Theme.ash) }
                    }
                    .padding(.horizontal, Theme.inset).frame(height: Theme.rowHeight)
                    .background(i == menu.index ? Theme.raised : Color.clear)
                    .overlay(alignment: .leading) { if i == menu.index { Rectangle().fill(Theme.signal).frame(width: 2) } }
                }
            }
        }
    }
}
