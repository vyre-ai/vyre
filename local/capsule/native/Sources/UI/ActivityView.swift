// ActivityView: a conversation as Lumen draws it (SPEC-0.3.0 part 11.5): a header that says who and what state, the thinking line
// (the latest thought, opening to the whole), step rows that tick from running to done, a hand-off row ("Asked kit (billing)") with the
// teammate's own steps nested under it and its report-back, and the reply. What a teammate wrote is shown as data: quoted, in a quieter
// ink, never in the person's voice. Drawn from an ActivityFeed (Core); this file holds no state of its own beyond the thinking line's tap.

import SwiftUI

struct ActivityView: View {
    var feed: ActivityFeed
    /// Who the conversation is with: the agent's name, its project, its mark.
    var title: String
    var project: String? = nil
    var mark: AvatarKind
    var who = Identities()
    /// The thinking line opens to the whole of it.
    @State var thinkingOpen = false
    /// "Open in Vyre": the whole conversation in the app (one key).
    var openInApp: (() -> Void)? = nil
    var openHandoff: ((ActivityFeed.Handoff) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let line = feed.thinkingLine { thinking(line) }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(feed.rows) { row in rowView(row) }
            }
            .padding(.horizontal, Theme.inset).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            footer
        }
    }

    /// How tall the conversation wants to be: a line for the header, the thinking line, the footer, and one per row (words wrap at about 78 characters), up to what Lumen's panel allows.
    static func height(_ feed: ActivityFeed) -> CGFloat {
        func lines(_ r: ActivityFeed.Row) -> Int {
            switch r {
            case .user(_, let t), .reply(_, let t, _, _): return 2 + t.count / 78
            case .thinking: return 0
            case .step, .ask: return 1
            case .handoff(let h): return 1 + h.children.reduce(0) { $0 + lines($1) } + (h.result.map { 1 + $0.count / 78 } ?? 0)
            }
        }
        let n = 3 + (feed.thinkingLine == nil ? 0 : 1) + feed.rows.reduce(0) { $0 + lines($1) }
        return min(380, CGFloat(n) * 19 + 16)
    }

    // ---- header ---------------------------------------------------------------------------------------------------------------

    private var header: some View {
        HStack(spacing: 8) {
            AvatarView(mark, size: 18)
            Text(title).font(Theme.title).foregroundColor(Theme.stone)
            if let p = project, !p.isEmpty { Text(p).font(Theme.subtitle).foregroundColor(Theme.ash) }
            Spacer()
            let s = feed.headerState
            if !s.isEmpty {
                HStack(spacing: 5) {
                    if s == "working" || s == "thinking" { Circle().fill(Theme.signal).frame(width: 6, height: 6) }
                    else if s == "waiting for you" { Circle().fill(Theme.attention).frame(width: 6, height: 6) }
                    Text(s).font(Theme.subtitle).foregroundColor(s == "waiting for you" ? Theme.attention : Theme.ash)
                }
            }
        }
        .padding(.horizontal, Theme.inset).frame(height: CapsuleLayout.lineHeight)
    }

    // ---- the thinking line ------------------------------------------------------------------------------------------------------

    private func thinking(_ line: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: feed.thinkingNow ? "ellipsis" : "text.bubble").font(Theme.subtitle).foregroundColor(Theme.ash)
                Text(thinkingOpen ? "Thinking" : line).font(Theme.subtitle).italic().foregroundColor(Theme.ash).lineLimit(thinkingOpen ? 1 : 1).truncationMode(.tail)
                Spacer(minLength: 8)
                Image(systemName: thinkingOpen ? "chevron.up" : "chevron.down").font(Theme.subtitle).imageScale(.small).foregroundColor(Theme.ash)
            }
            if thinkingOpen {
                Text(feed.thinkingAll).font(Theme.subtitle).italic().foregroundColor(Theme.ash).textSelection(.enabled)
                    .padding(.leading, 18).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Theme.inset).padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { thinkingOpen.toggle() }
    }

    // ---- rows -------------------------------------------------------------------------------------------------------------------

    @ViewBuilder private func rowView(_ row: ActivityFeed.Row) -> some View {
        switch row {
        case .user(_, let text):
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) { AvatarView(who.person, size: 14); Text("You").font(Theme.label).foregroundColor(Theme.ash) }
                Text(Self.markdown(text)).font(Theme.reply).foregroundColor(Theme.bone).textSelection(.enabled)
            }
        case .reply(_, let text, let done, let author):
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) { AvatarView(markOf(author), size: 14); Text(name(of: author)).font(Theme.label).foregroundColor(Theme.signal) }
                Text(Self.markdown(text + (done ? "" : " …"))).font(Theme.reply).foregroundColor(Theme.bone).textSelection(.enabled)
            }
        case .thinking:
            EmptyView()   // thoughts are the thinking line above, not rows
        case .step(let s):
            StepRow(step: s)
        case .handoff(let h):
            HandoffRow(handoff: h, who: who, open: openHandoff)
        case .ask(_, let title, let open):
            HStack(spacing: 6) {
                Image(systemName: open ? "questionmark.circle.fill" : "checkmark.circle").font(Theme.subtitle).foregroundColor(open ? Theme.attention : Theme.ash)
                Text(title).font(Theme.subtitle).foregroundColor(open ? Theme.stone : Theme.ash).lineLimit(1)
            }
        }
    }

    private func markOf(_ author: String?) -> AvatarKind { author.map { ActivityView.markFor($0, who: who) } ?? .agent(title) }
    private func name(of author: String?) -> String { author.map(ActivityFeed.plain) ?? title }

    /// An author id ("assistant:juno", "person:alex") as a mark.
    static func markFor(_ author: String, who: Identities) -> AvatarKind {
        if author.hasPrefix("person:") { return who.person }
        let name = ActivityFeed.plain(author)
        if author.hasPrefix("assistant:") && (who.assistantName == nil || who.assistantName?.lowercased() == name.lowercased()) { return who.assistant(name) }
        return .agent(String(author.split(separator: ":").last ?? Substring(author)))
    }

    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    // ---- footer: follow-ups are typed in the same bar; one key opens the whole conversation in the app --------------------------------------

    private var footer: some View {
        HStack(spacing: 10) {
            Text("type to follow up").font(Theme.subtitle).foregroundColor(Theme.ash)
            Spacer()
            if let openInApp {
                Button(action: openInApp) { Text("Open in Vyre  ⌘O").font(Theme.subtitle).foregroundColor(Theme.stone) }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Theme.inset).frame(height: CapsuleLayout.lineHeight)
    }
}

/// One step: a mark that ticks from running to done (or fails), the words, and what it is.
struct StepRow: View {
    var step: ActivityFeed.Step
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: Self.symbol(step.status)).font(Theme.subtitle).imageScale(.small).foregroundColor(Self.tint(step.status))
            Text(step.summary.isEmpty ? step.tool : step.summary).font(Theme.subtitle).foregroundColor(step.status == .running ? Theme.stone : Theme.ash).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Text(Self.word(step.status)).font(Theme.subtitle).foregroundColor(Theme.ash)
        }
        .frame(height: Tokens.TypeScale.base.line)
    }
    static func symbol(_ s: ActivityFeed.StepStatus) -> String { switch s { case .running: return "circle.dotted"; case .done: return "checkmark.circle.fill"; case .failed: return "xmark.circle.fill" } }
    static func word(_ s: ActivityFeed.StepStatus) -> String { switch s { case .running: return "running"; case .done: return "done"; case .failed: return "failed" } }
    static func tint(_ s: ActivityFeed.StepStatus) -> Color { switch s { case .running: return Theme.signal; case .done: return Theme.ash; case .failed: return Theme.attention } }
}

/// "Asked kit (billing)", its state, the teammate's own steps nested under it, and the report-back as quoted data.
struct HandoffRow: View {
    var handoff: ActivityFeed.Handoff
    var who: Identities
    var open: ((ActivityFeed.Handoff) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                AvatarView(.agent(handoff.agent.isEmpty ? handoff.name : handoff.agent), size: 14)
                Text(handoff.label).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1)
                if let p = handoff.project, !p.isEmpty { Text(p).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1) }
                Spacer(minLength: 8)
                Text(Self.word(handoff.state)).font(Theme.subtitle).foregroundColor(handoff.state == .failed ? Theme.attention : Theme.ash)
                if handoff.thread != nil, let open { Button { open(handoff) } label: { Image(systemName: "arrow.up.right").imageScale(.small).foregroundColor(Theme.ash) }.buttonStyle(.plain) }
            }
            .frame(height: Tokens.TypeScale.base.line)
            if !handoff.children.isEmpty || handoff.result != nil {
                HStack(alignment: .top, spacing: 8) {
                    Rectangle().fill(Theme.rule).frame(width: 2).padding(.leading, 6)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(handoff.children) { c in child(c) }
                        if let r = handoff.result {
                            Text(r).font(Theme.subtitle).foregroundColor(Theme.stone).textSelection(.enabled)
                                .padding(.vertical, 2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func child(_ row: ActivityFeed.Row) -> some View {
        switch row {
        case .step(let s): StepRow(step: s)
        case .reply(_, let t, _, _): Text(ActivityView.markdown(t)).font(Theme.subtitle).foregroundColor(Theme.stone).fixedSize(horizontal: false, vertical: true)
        default: EmptyView()
        }
    }

    static func word(_ s: ActivityFeed.HandoffState) -> String {
        switch s { case .queued: return "queued"; case .running: return "working"; case .done: return "done"; case .failed: return "failed"; case .cancelled: return "cancelled" }
    }
}
