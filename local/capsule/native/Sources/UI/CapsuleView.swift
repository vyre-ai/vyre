// CapsuleView: the bar, the answer to an Ask, and the results, drawn from CapsuleModel.
//
// Keys are handled by the panel (Host/Panel.swift) before the text field sees them, so arrows,
// Enter and Escape behave the same whatever has focus. This view only draws.
//
// Layout (docs/design/system/capsule.md): the bar (56), then one area of fixed height, 504, so the
// open panel is 560: the body (results, memory, an answer, a side panel), a status line when there
// is one, and the footer, which holds keys only. An answer's card grows with its words, then
// scrolls (AnswerScroll.swift). Rows are inset and rounded; the selected one is a
// raised plate with the signal pill at its left edge. The top hit is larger, like Spotlight's.

import AppKit
import LocalAuthentication
import SwiftUI
import UniformTypeIdentifiers

struct CapsuleView: View {
    @ObservedObject var model: CapsuleModel
    @ObservedObject var focus: FocusTicket
    /// Drawn off screen for a picture: a solid ground, since a window's material needs a window.
    var snapshot = false
    @FocusState private var boxFocused: Bool

    var body: some View {
        let open = CapsuleLayout.isOpen(model)
        VStack(spacing: 0) {
            bar
            if open {
                // One area of fixed height below the bar, like Spotlight's: results, memory and
                // answers arrive in waves inside it and never resize the panel mid-word.
                VStack(spacing: 0) {
                    if let a = model.presenceAsk {
                        PresenceView(ask: a, hasTouchID: LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil))
                    } else if let c = model.credentialAsk {
                        CredentialView(ask: c) { Task { await model.saveCredential() } }
                    } else if let run = model.commandRun, !(model.current?.kind == "cli" && model.current?.id != "cli:" + run.title) {
                        // What a command said, until a different command is typed (CommandRun.swift).
                        CommandRunView(run: run, scroller: model.answerScroll, cap: CapsuleLayout.answerCap(model, alone: true))
                        Spacer(minLength: 0)
                    } else if AgentLayout.deskShown(model) {
                        // What waits on the user (the list, a card) or ⌘K takes the whole area (Agent/).
                        AgentLayout.desk(model)
                    } else if model.answerAlone && side == nil {
                        // An answer alone gets the whole area, and scrolls in it.
                        answerCard(cap: CapsuleLayout.answerCap(model, alone: true))
                        Spacer(minLength: 0)
                    } else {
                        // Offline, and the conversation with an @agent above its rows (Agent/).
                        AgentLayout.above(model)
                        // The answer grows with its words up to the room left above a few results,
                        // then scrolls (AnswerScroll.swift). It never clips a line out of reach.
                        if model.asked != nil { answerCard(cap: CapsuleLayout.answerCap(model, alone: false)); Rule() }
                        if model.showsMemory, let m = model.memory { MemoryLine(memory: m, expanded: $model.memoryExpanded, who: model.identities); Rule() }
                        HStack(alignment: .top, spacing: 0) {
                            if !model.groups.isEmpty { results } else { Spacer(minLength: 0) }
                            if let side {
                                Rectangle().fill(Theme.rule).frame(width: 1)
                                side.frame(width: CapsuleLayout.sideWidth).frame(maxHeight: .infinity, alignment: .top)
                            }
                        }
                        .frame(maxHeight: .infinity, alignment: .top)
                    }
                    // Status ("Copied", "Are you sure?") is one line above the footer, never in it.
                    if let s = CapsuleLayout.status(model) { statusLine(s) }
                    footer
                }
                .frame(height: CapsuleLayout.area, alignment: .top)
                .clipped()
                .overlay(alignment: .top) { Rule() }
            } else {
                // Compact (capsule.md): the input, what waits on you, a passing line, the footer.
                VStack(spacing: 0) {
                    AgentLayout.compact(model)
                    if let line = model.line, !line.isEmpty { lineView(line) }
                    footer
                }
                .overlay(alignment: .top) { Rule() }
            }
        }
        .frame(width: Theme.width, height: CapsuleLayout.panelHeight(model), alignment: .top)
        .background { if snapshot { Theme.carbon } else { Backdrop() } }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(DeepGlass.border, lineWidth: 1))
        .overlay(alignment: .top) {
            // A hairline of light along the top edge, as on the Mac's own panels.
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(LinearGradient(colors: [Theme.bone.opacity(DeepGlass.topEdgeAlpha), .clear], startPoint: .top, endPoint: .center), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .onChange(of: focus.count) { boxFocused = true }
        .onAppear { boxFocused = true }
    }

    // MARK: the bar

    private var bar: some View {
        HStack(spacing: 12) {
            MarkView(size: 20)
            if let c = model.target {
                HStack(spacing: 5) {
                    // An extension's target shows the icon it gave (an app's own); the outer chip
                    // of a two-level one leads, "WhatsApp › juno".
                    chipIcon(model.targetParent ?? c)
                    if let p = model.targetParent {
                        Text(p.label).font(Theme.type(Tokens.TypeScale.base, .medium)).foregroundColor(Theme.stone).lineLimit(1)
                        Text("›").font(Theme.subtitle).foregroundColor(Theme.ash)
                    }
                    Text(c.label).font(Theme.type(Tokens.TypeScale.base, .medium)).lineLimit(1)
                }
                .foregroundColor(Theme.bone)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Capsule().fill(Theme.raised))
                .overlay(Capsule().strokeBorder(Theme.signal.opacity(0.55), lineWidth: 1))
                .frame(maxWidth: 240, alignment: .leading)
                .fixedSize()
            }
            TextField("", text: $model.text, prompt: Text(CapsuleLayout.placeholder(model)).foregroundColor(Theme.ash))
                .textFieldStyle(.plain)
                .font(Theme.query)
                .foregroundColor(Theme.bone)
                .focused($boxFocused)
            ForEach(model.attachments, id: \.id) { a in
                HStack(spacing: 5) {
                    Image(systemName: "rectangle.dashed.and.paperclip").imageScale(.small)
                    Text(a.chip).lineLimit(1).truncationMode(.middle)
                    Button { model.removeAttachment(a.id) } label: { Image(systemName: "xmark").imageScale(.small) }
                        .buttonStyle(.plain).help("Leave it off (⌘⌫)")
                }
                .font(Theme.type(Tokens.TypeScale.meta, .medium))
                .foregroundColor(Theme.bone)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Capsule().fill(Theme.signal.opacity(0.12)))
                .overlay(Capsule().strokeBorder(Theme.signal.opacity(0.4), lineWidth: 1))
                .frame(maxWidth: 230)
                .fixedSize(horizontal: false, vertical: true)
            }
            if model.attachments.isEmpty, let item = model.current, let s = item.sendsTo {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.up.right").imageScale(.small)
                    Text(s).lineLimit(1)
                }
                .font(Theme.type(Tokens.TypeScale.meta, .medium))
                .foregroundColor(Theme.stone)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .fixedSize()
            }
            // The project the Capsule is in (ProjectContext.swift): its tile and name, read-only.
            if model.target == nil, model.attachments.isEmpty, model.current?.sendsTo == nil, let p = model.currentProject {
                HStack(spacing: 5) {
                    AvatarView(.project(seed: p.tileSeed, draft: false), size: 14)
                    Text(p.name).lineLimit(1).truncationMode(.tail)
                }
                .font(Theme.type(Tokens.TypeScale.meta, .medium))
                .foregroundColor(Theme.stone)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .frame(maxWidth: 160)
                .fixedSize(horizontal: false, vertical: true)
                .help("Answers use this project")
            }
        }
        .padding(.horizontal, Theme.inset)
        .frame(height: Theme.barHeight)
    }

    /// The chip's icon: the picture an extension gave its target (an app's own icon), its symbol,
    /// or the symbol for what kind of thing Vyre's own target is.
    @ViewBuilder private func chipIcon(_ c: VyreCandidate) -> some View {
        let spec = model.mentionIcon(c)
        if case .symbol(let name, _)? = spec {
            Image(systemName: name).font(Theme.subtitle)
        } else if let spec, let img = model.icons.image(spec, points: 14, scale: 2) {
            Image(nsImage: img).resizable().interpolation(.high).frame(width: 14, height: 14)
        } else {
            Image(systemName: c.kind == .agent ? "person.crop.circle" : c.kind == .project ? "folder" : c.kind == .app ? "app" : "text.bubble")
                .font(Theme.subtitle)
        }
    }

    // MARK: the answer (capsule-now rule 4: the question, who answers, memory, then the answer)

    private var answer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                AvatarView(model.identities.person, size: 16)
                Text("You").font(Theme.subtitle).foregroundColor(Theme.ash)
                Text(model.asked ?? "").font(Theme.type(Tokens.TypeScale.base, .medium)).foregroundColor(Theme.bone).lineLimit(2)
            }
            // The header: "Vyre IQ" 12/600 and "quick" or "deeper", as the group headers are; with
            // an @ target, the mark and its name.
            HStack(alignment: .center, spacing: 7) {
                let working = model.reply.map { !$0.finished } == true || model.pending
                if let depth = CapsuleLayout.answerDepth(model) {
                    if working { Pulse() }
                    AvatarView(model.replyAvatar, size: 18)
                    Text("Vyre IQ").font(Theme.label).foregroundColor(Theme.ash)
                    Text(depth).font(Theme.subtitle).foregroundColor(Theme.ash)
                } else {
                    if working { Pulse() }
                    AvatarView(model.replyAvatar, size: 18)
                    Text(model.replyWho).font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.bone)
                }
                let state = replyState
                if !state.isEmpty { Text(state).font(Theme.subtitle).foregroundColor(Theme.ash) }
                Spacer()
            }
            // Before the answer is in, what memory said is the answer so far; once it is in, the
            // answer already uses it, so it folds into one line under the answer.
            if let m = model.askedMemory, model.replyText.isEmpty { MemoryLine(memory: m, expanded: $model.memoryExpanded, inset: false, who: model.identities) }
            // Tool calls, collapsed to one line each, newest three; a row changes in place.
            if let tools = model.reply?.tools, !tools.isEmpty { ToolRows(tools: tools) }
            if let q = model.reply?.queued, !q.withdrawn {
                Label(q.delivered ? "Handed over to \(q.name). Its answer shows here as it comes." : "Queued for \(q.name): it gets this when its current turn ends.",
                      systemImage: q.delivered ? "checkmark.circle" : "clock")
                    .font(Theme.subtitle).foregroundColor(Theme.stone)
            }
            // Vyre IQ's draft (C13 memory.draft): dimmed, with "Checking", until the answer replaces it.
            if model.pending, model.replyText.isEmpty, let draft = model.iqDraft {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Checking").font(Theme.subtitle).foregroundColor(Theme.ash)
                    Text(draft)
                        .font(Theme.reply).foregroundColor(Theme.stone)
                        .lineSpacing(Theme.lineGap(Tokens.TypeScale.read))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .opacity(0.6)
                .accessibilityLabel("Checking: \(draft)")
            }
            if !model.replyText.isEmpty {
                Text(markdown(model.shownReplyText))
                    .font(Theme.reply).foregroundColor(Theme.bone)
                    .lineSpacing(Theme.lineGap(Tokens.TypeScale.read))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let m = model.askedMemory, !model.replyText.isEmpty, !m.sources.isEmpty || m.corrected {
                MemorySources(memory: m, expanded: $model.memoryExpanded, who: model.identities, assistant: model.assistantName, openSource: { model.openSource($0) })
            }
            // Vyre IQ corrections (95b2b891): a quiet "Wrong?" line, its panel, or the last fix's Undo.
            if model.reply?.finished == true, let id = model.iqAnswerId {
                if let fixed = model.iqFixed {
                    IQFixedLine(fix: fixed) { model.undoIQFix() }
                } else if let c = model.iqCorrecting, c.answerId == id {
                    IQCorrectPanel(state: c, onWrong: { model.correctIQ(action: "wrong") }, onForget: { model.correctIQ(action: "forget") },
                                   onReplace: { model.correctIQ(action: "replace", object: $0) }, onCancel: { model.cancelIQCorrect() })
                } else {
                    IQWrongLine { model.openIQCorrect() }
                }
            }
            if let r = model.reply, r.finished, let e = r.error, r.queued?.withdrawn != true {
                Label(e == "stopped" ? "Stopped." : "Failed. \(e)", systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone)
            }
            // Rule 3: a notice is status, one faint line, never part of the answer.
            if let n = model.reply?.notice, !n.isEmpty {
                Text(n).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(2)
            }
        }
        .padding(.horizontal, Theme.inset).padding(.top, 14).padding(.bottom, Theme.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func answerCard(cap: CGFloat) -> some View {
        AnswerScroll(scroller: model.answerScroll, cap: cap, grows: model.visibleReplyCount + (model.reply?.tools.count ?? 0),
                     answerID: model.reply?.thread ?? model.asked ?? "") { answer }
    }

    private var replyState: String {
        // Vyre IQ streaming (memory.thinking): the stage in words while memory.ask is out.
        if model.pending, let stage = model.iqStage { return stage }
        if model.pending { return "starting" }
        guard let r = model.reply else { return "" }
        if let q = r.queued, !q.delivered, !r.finished { return "queued" }
        if r.queued?.withdrawn == true { return "taken back" }
        if !r.finished {
            // thread.state (ADR 0030): an open ask is the status model's "needs you".
            if r.state == "waiting" { return Theme.status("needsYou")?.word ?? "needs you" }
            if r.state == "starting" { return "starting" }
            return model.replyText.isEmpty ? "thinking" : "answering"
        }
        var parts = [r.state == "failed" || (r.ok == false && r.error != "stopped") ? "failed" : r.ok == false ? "stopped" : "done"]
        // Vyre IQ says "quick" or "deeper" instead of the model; an @ target keeps the model's name.
        if let m = r.model, CapsuleLayout.answerDepth(model) == nil { parts.insert(m, at: 0) }
        if let c = r.cost { parts.append(String(format: "$%.3f", c)) }
        if r.idle { parts.append("idle") }
        return parts.joined(separator: " · ")
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    // MARK: results

    private var results: some View {
        let flat = model.flat
        let index = Dictionary(flat.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        return GeometryReader { geo in ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    // A heading is drawn only over rows: an empty group never shows a bare "Send to".
                    ForEach(model.groups.filter { !$0.items.isEmpty }) { g in
                        SectionHeader(title: CapsuleLayout.heading(g))
                        ForEach(g.items) { item in
                            let i = index[item.id] ?? -1
                            Row(item: item, selected: i == model.selected, top: g.section == .top || item.kind == "calc", icons: model.icons)
                                .equatable()
                                .id(item.id)
                                .contentShape(Rectangle())
                                .onTapGesture { model.selected = i; model.run() }
                        }
                    }
                }
                .padding(.bottom, 6)
            }
            // The list ends on a whole row, so a heading is never left at the bottom with its
            // rows out of sight; the rows past it are still a scroll away.
            .frame(height: CapsuleLayout.fit(model.groups.filter { !$0.items.isEmpty }, in: geo.size.height), alignment: .top)
            .onChange(of: model.selected) { if let id = model.current?.id { proxy.scrollTo(id) } }
        } }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// An extension's side panel for the selected row, or the one it asked to show.
    private var side: AnyView? { _ = model.panelTick; return model.panelFor?(model.current) }

    // MARK: the footer: keys only (what the keys do right now), and the status line above it

    private var footer: some View {
        HStack(spacing: 16) {
            ForEach(CapsuleLayout.footerHints(model), id: \.self) { KeyHint(title: $0.title, keys: $0.keys) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.inset)
        .frame(height: CapsuleLayout.footerHeight)
        .background(Theme.graphite.opacity(0.35))
        .overlay(alignment: .top) { Rule() }
    }

    private func statusLine(_ s: String) -> some View {
        Text(s).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, Theme.inset)
            .frame(maxWidth: .infinity, minHeight: CapsuleLayout.lineHeight, maxHeight: CapsuleLayout.lineHeight, alignment: .leading)
    }

    private func lineView(_ s: String) -> some View {
        Text(s).font(Theme.subtitle).foregroundColor(Theme.stone)
            .padding(.horizontal, Theme.inset).frame(maxWidth: .infinity, minHeight: CapsuleLayout.lineHeight, maxHeight: CapsuleLayout.lineHeight, alignment: .leading)
    }
}

enum CapsuleLayout {
    static let footerHeight: CGFloat = Theme.footerHeight
    /// The fixed area under the bar while anything is shown there: the body and the footer, so the
    /// open panel is 560 and the body 472 (560 - 56 - 32). The rule under the bar is drawn over it.
    static let area: CGFloat = Theme.maxHeight - Theme.barHeight
    /// The status line above the footer, and the one line under a closed bar.
    static let lineHeight: CGFloat = Tokens.Control.sm

    @MainActor static func isOpen(_ m: CapsuleModel) -> Bool {
        m.presenceAsk != nil || m.credentialAsk != nil || m.commandRun != nil || m.asked != nil || !m.groups.isEmpty || m.showsMemory || m.panelFor?(m.current) != nil || AgentLayout.opens(m)
    }

    /// The open panel's height (560): the bar, the body and the footer.
    static var openHeight: CGFloat { Theme.barHeight + area }

    /// The panel's height: open, the bar and the fixed area (560); compact, the bar, what waits on
    /// you (offline, up to three rows), a passing line, and the footer.
    @MainActor static func panelHeight(_ m: CapsuleModel) -> CGFloat {
        if isOpen(m) { return openHeight }
        var h = Theme.barHeight + AgentLayout.compactHeight(m) + footerHeight
        if let l = m.line, !l.isEmpty { h += lineHeight }
        return h
    }

    /// The status line above the footer: what was said ("Copied"), or what Enter again confirms.
    @MainActor static func status(_ m: CapsuleModel) -> String? {
        if let l = m.line, !l.isEmpty { return l }
        if let c = m.confirming, let words = c.action.confirm, !words.isEmpty { return words }
        return nil
    }

    /// The body between the bar and the footer, less the status line when it shows.
    @MainActor static func body(_ m: CapsuleModel) -> CGFloat {
        area - footerHeight - (status(m) != nil ? lineHeight : 0)
    }

    /// The most room the answer card may take. Alone, the whole body; above results, that less a
    /// heading and two rows, so the results stay in reach.
    @MainActor static func answerCap(_ m: CapsuleModel, alone: Bool) -> CGFloat {
        let room = body(m)
        if alone { return room }
        let memory: CGFloat = m.showsMemory ? 40 : 0
        // The first group, with up to two of its rows, stays in sight under the card.
        let results = m.groups.first { !$0.items.isEmpty }.map { g in
            6 + Theme.headerHeight + g.items.prefix(2).enumerated().reduce(0) { $0 + rowHeight($1.element, top: g.section == .top) }
        } ?? 0
        return max(Theme.rowHeight * 2, room - 1 - memory - results)
    }

    // MARK: copy

    /// The field's placeholder: a chip's "Message", the follow-up box, else the Capsule's own.
    @MainActor static func placeholder(_ m: CapsuleModel) -> String {
        m.target != nil ? "Message" : m.followUp ? "Ask a follow-up" : "Ask Vyre, find, or run"
    }

    /// A group's heading, as written (sentence case): "Send to" over @ names, else its section.
    static func heading(_ g: CapsuleModel.Group) -> String {
        g.items.allSatisfy { $0.kind == "mention" } ? "Send to" : g.section.rawValue
    }

    /// The answer card's title: "Vyre IQ", or the @ target's (or queued session's) name.
    @MainActor static func answerTitle(_ m: CapsuleModel) -> String {
        answerDepth(m) != nil ? "Vyre IQ" : m.replyWho
    }

    /// "quick" or "deeper" beside "Vyre IQ" (deeper on the model ⌘⏎ switches to); nil with an @
    /// target or a queued session, which keep their own name.
    @MainActor static func answerDepth(_ m: CapsuleModel) -> String? {
        guard m.target == nil, m.reply?.queued == nil else { return nil }
        return m.reply?.model == CapsuleModel.deeperModel ? "deeper" : "quick"
    }

    // MARK: the footer

    /// One key hint: the keys, drawn as caps, and what they do.
    struct Hint: Hashable, CustomStringConvertible {
        let title: String
        let keys: [String]
        init(_ title: String, _ keys: [String]) { self.title = title; self.keys = keys }
        var description: String { keys.joined() + " " + title }
    }

    /// The footer's hints for the state on screen, left to right, four at most (the spec's "footer,
    /// by state" table). Only keys Panel.swift and AgentPanelKeys.swift act on; ⌘O only with a thread.
    @MainActor static func footerHints(_ m: CapsuleModel) -> [Hint] {
        Array(hints(m).prefix(4))
    }

    @MainActor private static func hints(_ m: CapsuleModel) -> [Hint] {
        let move = Hint("Move", ["↑", "↓"]), deeper = Hint("Think deeper", ["⌘", "⏎"])
        let openInVyre: [Hint] = m.reply.map { !$0.thread.isEmpty } == true ? [Hint("Open in Vyre", ["⌘", "O"])] : []
        let escText = Hint(m.text.isEmpty ? "Hide" : "Clear", ["esc"])
        if m.presenceAsk != nil { return [Hint("Cancel", ["esc"])] }
        if let c = m.credentialAsk { return c.saving ? [] : [Hint("Save in the vault", ["⏎"]), Hint("Cancel", ["esc"])] }
        if let r = m.commandRun, m.current?.kind != "cli" { return r.running ? [Hint("Stop", ["esc"])] : [Hint("Clear", ["esc"])] }
        if m.actionMenu.isOpen { return [move, Hint("Run", ["⏎"]), Hint("Back", ["esc"])] }
        switch m.desk.mode {
        case .list:
            // Ask focused: A and D answer it where it is; ⏎ opens its card.
            if let w = m.desk.highlighted, w.source == .ask {
                return [Hint("Allow once", ["A"]), Hint("Deny", ["D"]), Hint("Review", ["⏎"]), Hint("Close", ["esc"])]
            }
            let yes = m.desk.highlighted.map { [Hint($0.source == .lesson ? "Accept" : "Send", ["A"])] } ?? []
            return [move] + yes + [Hint("Review", ["⏎"]), Hint("Close", ["esc"])]
        case .card:
            guard let w = m.desk.open else { break }
            if w.source == .gate { return [Hint("Send", ["⌘", "⏎"]), Hint("Back", ["esc"])] }
            return [Hint(w.source == .lesson ? "Accept" : "Allow", ["⏎"]), Hint("Back", ["esc"])]
        case .none: break
        }
        if m.confirming != nil { return [Hint("Confirm", ["⏎"]), Hint("Cancel", ["esc"])] }
        // Listening: the talk chord again stops (a held one stops on release).
        if m.dictating { return [Hint("Stop", ["⌥", "⏎"])] }
        if let r = m.reply, !r.finished || m.pending {
            // Using your Mac: Esc stops the agent's hands and its turn.
            if m.doing { return [Hint("Stop", ["esc"])] + openInVyre }
            return [Hint("Stop", ["esc"])] + (m.target == nil ? [deeper] : [])
        }
        // Computer use that stopped or finished: open the session, or clear.
        if m.doing, m.reply != nil { return openInVyre + [Hint("Clear", ["esc"])] }
        // Read aloud: Esc stops the voice (and clears the answer).
        if m.target == nil, m.asked != nil, m.speaking { return [Hint("Ask", ["⏎"]), deeper] + openInVyre + [Hint("Stop", ["esc"])] }
        // Question typed, an answer on top, or the follow-up box: ⏎ asks, ⌘⏎ thinks deeper.
        if m.target == nil && (m.followUp || (m.asked != nil && !m.userMoved) || questionTyped(m)) {
            return [Hint("Ask", ["⏎"]), deeper] + openInVyre + [Hint("Clear", ["esc"])]
        }
        guard let item = m.current else {
            // Nothing typed, with rows waiting under the box: ↑↓ into the list, ⏎ the oldest.
            if AgentLayout.hintShown(m) { return [move, Hint("Open", ["⏎"]), Hint("Hide", ["esc"])] }
            return m.text.isEmpty && m.target == nil ? [Hint("Hide", ["esc"])] : [escText]
        }
        var out = [move]
        if let first = item.actions.first { out.append(Hint(first.title, ["⏎"])) }
        if let alt = item.actions.dropFirst().first(where: { $0.shortcut == KeyShortcut("return", command: true) }) {
            out.append(Hint(alt.title, ["⌘", "⏎"]))
        } else if let send = item.actions.first(where: { $0.id == "send-box" }) {
            out.append(Hint(send.title, ["⌘", "S"]))
        } else {
            out += openInVyre
        }
        return Array(out.prefix(3)) + [escText]
    }

    /// Words in the box that ⏎ would ask Vyre IQ about (AutoAsk.handleReturn's own test).
    @MainActor static func questionTyped(_ m: CapsuleModel) -> Bool {
        guard !m.userMoved, m.mentionQuery == nil else { return false }
        let words = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, CapsuleModel.doRequest(words) == nil else { return false }
        let top = m.topLocal
        return CapsuleModel.wantsAnswer(words, topKind: top?.kind, topScore: top?.score ?? 0) && m.quickFirst(words)
    }

    /// A row's height: the top hit is larger, like Spotlight's, and a sum larger still.
    static func rowHeight(_ item: ResultItem, top: Bool) -> CGFloat {
        item.kind == "calc" ? Theme.rowHeight + 22 : top ? Theme.rowHeight + 12 : Theme.rowHeight
    }

    /// The tallest the results list can be in `height` and still end on a whole row: a heading
    /// is counted only with its first row. With room for everything, all of it.
    static func fit(_ groups: [CapsuleModel.Group], in height: CGFloat) -> CGFloat {
        var h: CGFloat = 0
        outer: for g in groups {
            let top = g.section == .top
            guard let first = g.items.first, h + Theme.headerHeight + rowHeight(first, top: top || first.kind == "calc") <= height else { break }
            h += Theme.headerHeight
            for item in g.items {
                let r = rowHeight(item, top: top || item.kind == "calc")
                if h + r > height { break outer }
                h += r
            }
        }
        return h > 0 && h + 6 <= height ? h + 6 : h
    }

    /// The card's height for words `content` tall: as tall as they are, up to `cap`. Before the
    /// first measure, a small card rather than none.
    static func answerHeight(content: CGFloat, cap: CGFloat) -> CGFloat {
        content <= 0 ? min(cap, 80) : min(content.rounded(.up), cap)
    }

    static let sideWidth: CGFloat = 260
    static let sideMin: CGFloat = 180
}

/// Hands focus back to the box each time the panel shows.
@MainActor final class FocusTicket: ObservableObject {
    @Published var count = 0
}

struct Rule: View {
    var body: some View { Rectangle().fill(Theme.rule).frame(height: 1) }
}

struct SectionHeader: View {
    let title: String
    var body: some View {
        // As written, in sentence case: never caps.
        Text(title)
            .font(Theme.label)
            .foregroundColor(Theme.ash)
            .padding(.horizontal, Theme.inset).padding(.bottom, 4)
            .frame(maxWidth: .infinity, minHeight: Theme.headerHeight, alignment: .bottomLeading)
    }
}

/// "⏎ Open": the key drawn as a small cap, then what it does, 12/16 in `label`.
struct KeyHint: View {
    let title: String
    let keys: [String]
    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 2) { ForEach(keys, id: \.self) { KeyCap(key: $0) } }
            Text(title).font(Theme.subtitle).foregroundColor(Theme.ash)
        }
        .fixedSize()
    }
}

struct KeyCap: View {
    let key: String
    var body: some View {
        Text(key).font(Theme.type(Tokens.TypeScale.meta, .semibold)).foregroundColor(Theme.stone)
            .frame(minWidth: Tokens.TypeScale.base.line, minHeight: Tokens.TypeScale.base.line).padding(.horizontal, 2)
            .background(RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
    }
}

/// A turn's tool calls as one quiet line each: a mark, what it does, and its status word. The
/// newest three show; older ones are counted. Rows keep their place as their status changes.
struct ToolRows: View {
    let tools: [ReplyTool]

    var body: some View {
        let shown = tools.suffix(3)
        VStack(alignment: .leading, spacing: 3) {
            if tools.count > shown.count {
                Text("\(tools.count - shown.count) earlier").font(Theme.subtitle).foregroundColor(Theme.ash)
            }
            ForEach(shown, id: \.id) { t in
                HStack(spacing: 6) {
                    Image(systemName: Self.symbol(t.status)).font(Theme.subtitle).imageScale(.small).foregroundColor(Self.tint(t.status))
                    Text(t.summary).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text(Self.word(t.status)).font(Theme.subtitle).foregroundColor(Theme.ash)
                }
                .frame(height: Tokens.TypeScale.base.line)
            }
        }
        .animation(nil, value: tools)
    }

    static func word(_ s: ToolStatus) -> String {
        switch s { case .running: return "running"; case .completed: return "done"; case .failed: return "failed"; case .canceled: return "canceled" }
    }
    static func symbol(_ s: ToolStatus) -> String {
        switch s { case .running: return "circle.dotted"; case .completed: return "circle"; case .failed: return "xmark.circle"; case .canceled: return "minus.circle" }
    }
    static func tint(_ s: ToolStatus) -> Color {
        switch s { case .running: return Theme.signal; case .completed: return Theme.ash; case .failed: return Theme.stone; case .canceled: return Theme.ash }
    }
}

/// The signal dot breathing while an answer is on its way. The only motion that loops, and only
/// while something is actually happening.
struct Pulse: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.signal).frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .frame(width: 13, height: 13)
            .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { on = true } }
    }
}

/// The memory box (capsule-now rules 1, 2, 7): the fact first, then quotes as quotes with who
/// said them and when. These same lines, and no others, go with a quick question. A recall-tinted
/// rule on its left says it came from memory, where no model was used.
struct MemoryBox: View {
    let memory: MemoryAnswer
    var inset = true
    var body: some View {
        let items = Memo.items(memory)
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 1).fill(Theme.recall.opacity(0.85)).frame(width: 2)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle.magnifyingglass").imageScale(.small)
                    Text(memory.label)
                }
                .font(Theme.label).foregroundColor(Theme.recall)
                ForEach(items) { it in
                    if it.kind == .quote {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\u{201C}\(it.text)\u{201D}").font(Theme.title).foregroundColor(Theme.stone).lineLimit(2)
                            HStack(spacing: 6) {
                                Text("\(it.who ?? "You") said\(it.age.isEmpty ? "" : ", " + Memo.ago(it.age))")
                                if let s = it.source { Text("·"); Text(s.name).lineLimit(1) }
                            }
                            .font(Theme.subtitle).foregroundColor(Theme.ash)
                        }
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(it.text).font(Theme.type(Tokens.TypeScale.read, .medium)).foregroundColor(Theme.bone).lineLimit(2)
                            if !it.age.isEmpty { Text(Memo.ago(it.age)).font(Theme.subtitle).foregroundColor(Theme.ash) }
                        }
                    }
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, inset ? Theme.inset : 0).padding(.vertical, inset ? 10 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Its height, for sizing before SwiftUI lays it out.
    static func height(_ m: MemoryAnswer) -> CGFloat {
        20 + 18 + Memo.items(m).reduce(0) { $0 + ($1.kind == .quote ? 36 : 22) }
    }
}

/// Memory's answer as one line (the user asked for that over a wall of quotes): the answer, how
/// sure memory is, and how many conversations it comes from; the sources fold away behind a click
/// or ⌘→. Recall's colour says it came from memory, where no model was used. Shown only when there
/// is an answer at all (CapsuleModel.showsMemory).
struct MemoryLine: View {
    let memory: MemoryAnswer
    @Binding var expanded: Bool
    var inset = true
    var who = Identities()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.14)) { expanded.toggle() } } label: {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "sparkle.magnifyingglass").font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.recall)
                    Text(memory.answer ?? "").font(Theme.type(Tokens.TypeScale.read, .medium)).foregroundColor(Theme.bone).lineLimit(2)
                    Spacer(minLength: 10)
                    Sureness(value: memory.answerKind == .said ? nil : memory.confidence)
                    let n = memory.conversationCount
                    if n > 0 {
                        Text(n == 1 ? "from 1 conversation" : "from \(n) conversations").font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
                    }
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(Theme.subtitle).imageScale(.small).foregroundColor(Theme.ash)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? "Fold the sources (⌘→)" : "Show where this comes from (⌘→)")
            if expanded { SourceList(memory: memory, who: who).padding(.leading, 23) }
        }
        .padding(.horizontal, inset ? Theme.inset : 0).padding(.vertical, inset ? 11 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Under an answer that used memory: "from 2 of your sessions", which unfolds into where. A Vyre
/// IQ answer (memory.iq) instead keeps the confidence line and shows up to three source chips,
/// ⌘1..⌘3, each opening that turn in Vyre (capsule.md); "you corrected this" and no chips when
/// via was "corrected" (its "fix:<n>" source is provenance, never a chip).
struct MemorySources: View {
    let memory: MemoryAnswer
    @Binding var expanded: Bool
    var who = Identities()
    /// The assistant's name, for its mark when there is no fingerprint.
    var assistant: String? = nil
    var openSource: (Int) -> Void = { _ in }
    var body: some View {
        if memory.iq {
            VStack(alignment: .leading, spacing: 6) {
                // Vyre IQ's line wears the assistant's mark: the answer is its own reading.
                HStack(spacing: 6) {
                    AvatarView(who.assistant(assistant), size: 14)
                    Text(IQAnswer.chip(memory))
                }
                .font(Theme.title).foregroundColor(Theme.stone)
                if memory.corrected { IQCorrectedLine() } else if !memory.sources.isEmpty { IQSourceChips(memory: memory, open: openSource) }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                // A source chip (capsule.md): 28 tall, radius 14, 1 px ruleStrong, 13/18 text2.
                HStack(spacing: 6) {
                    let n = memory.conversationCount
                    Text(n == 1 ? "from 1 of your sessions" : "from \(n) of your sessions")
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").imageScale(.small).foregroundColor(Theme.ash)
                }
                .font(Theme.title).foregroundColor(Theme.stone)
                .padding(.horizontal, 10).frame(height: 28)
                .fixedSize()
                .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .contentShape(Capsule())
                .onTapGesture { withAnimation(.easeOut(duration: 0.14)) { expanded.toggle() } }
                .accessibilityAddTraits(.isButton)
                if expanded { SourceList(memory: memory, who: who) }
            }
        }
    }
}

/// Where memory's answer comes from: quotes as quotes, with who said them and when.
struct SourceList: View {
    let memory: MemoryAnswer
    var who = Identities()
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Memo.items(memory).filter { $0.kind == .quote || !$0.said && $0.text != memory.answer }) { it in
                VStack(alignment: .leading, spacing: 2) {
                    Text(it.kind == .quote ? "\u{201C}\(it.text)\u{201D}" : it.text).font(Theme.title).foregroundColor(Theme.stone).lineLimit(2)
                    HStack(spacing: 6) {
                        // A quote wears the mark of who said it: the person, or the assistant.
                        if it.kind == .quote { AvatarView(it.source?.role == "assistant" ? who.assistant() : who.person, size: 12) }
                        Text(it.kind == .quote ? "\(it.who ?? "You") said\(it.age.isEmpty ? "" : ", " + Memo.ago(it.age))" : "noted\(it.age.isEmpty ? "" : " " + Memo.ago(it.age))")
                        if let s = it.source { Text("·"); Text(s.name).lineLimit(1) }
                    }
                    .font(Theme.subtitle).foregroundColor(Theme.ash)
                }
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(Theme.recall.opacity(0.6)).frame(width: 2) }
    }
}

/// How sure memory is, as three small bars (nil: a line made from the user's own words, which is
/// as sure as the words were).
struct Sureness: View {
    let value: Double?
    var body: some View {
        let n = value.map { $0 >= 0.8 ? 3 : $0 >= 0.6 ? 2 : 1 } ?? 2
        HStack(spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1).fill(i < n ? Theme.recall : Theme.ruleStrong).frame(width: 3, height: 5 + CGFloat(i) * 3)
            }
        }
        .frame(height: 11, alignment: .bottom)
        .help(value.map { String(format: "Memory is %.0f%% sure", $0 * 100) } ?? "From your own words")
    }
}

/// A result row. Equatable on what it draws, so a keystroke that leaves a row as it was does not
/// draw it again.
struct Row: View, Equatable {
    nonisolated static func == (a: Row, b: Row) -> Bool {
        a.item.id == b.item.id && a.item.title == b.item.title && a.item.subtitle == b.item.subtitle && a.item.icon == b.item.icon
            && a.selected == b.selected && a.top == b.top && a.item.actions.first?.title == b.item.actions.first?.title
    }
    let item: ResultItem
    let selected: Bool
    var top = false
    let icons: IconCache
    @Environment(\.displayScale) private var scale

    private var iconSize: CGFloat { top ? 32 : Theme.iconSize }
    private var rowHeight: CGFloat { CapsuleLayout.rowHeight(item, top: top) }

    var body: some View {
        HStack(spacing: 12) {
            icon.frame(width: iconSize, height: iconSize)
            if top {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(item.kind == "calc" ? Theme.type(Tokens.TypeScale.title, .semibold, design: .rounded) : Theme.type(Tokens.TypeScale.read, .semibold))
                        .foregroundColor(Theme.bone).lineLimit(1).textSelection(.disabled)
                    if let sub = shownSubtitle { Text(sub).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1).truncationMode(.middle) }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                    if let sub = shownSubtitle {
                        Text(sub).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            Spacer(minLength: 10)
            if isLive {
                HStack(spacing: 5) {
                    Circle().fill(Theme.signal).frame(width: 6, height: 6)
                    Text("Live in terminal")
                }
                .font(Theme.type(Tokens.TypeScale.meta, .medium)).foregroundColor(Theme.signal)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Theme.signal.opacity(0.10)))
            } else if let k = RowKind.label(item) {
                Text(k).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
            }
        }
        .padding(.horizontal, Theme.inset - 6)
        .frame(height: rowHeight)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: Tokens.Radius.button, style: .continuous).fill(Theme.raised)
                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.button, style: .continuous).strokeBorder(Theme.bone.opacity(0.06), lineWidth: 1))
                    .overlay(alignment: .leading) {
                        Capsule().fill(Theme.signal).frame(width: 3, height: top ? 20 : 16).offset(x: -1)
                    }
            }
        }
        .padding(.horizontal, 6)
        .animation(.easeOut(duration: 0.09), value: selected)
    }

    /// App rows say only their name, as Spotlight's do; a folder path under an app is noise.
    private var shownSubtitle: String? {
        if item.subtitle.isEmpty || item.kind == "app" || item.kind == "system" { return nil }
        if isLive { let rest = item.subtitle.dropFirst(Self.live.count).drop { $0 == " " || $0 == "·" }; return rest.isEmpty ? nil : String(rest) }
        return item.subtitle
    }

    static let live = "live in terminal"
    private var isLive: Bool { item.kind == "mention" && item.subtitle.hasPrefix(Self.live) }

    @ViewBuilder private var icon: some View {
        if case .mark = item.icon {
            MarkView(size: top ? 24 : 20)
        } else if case .symbol(let name, let tint) = item.icon {
            // Symbols sit on a small tile so they line up with app icons beside them.
            RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous).fill(Theme.raised)
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous).strokeBorder(Theme.rule, lineWidth: 1))
                .overlay(Image(systemName: name).font(Theme.type(top ? Tokens.TypeScale.read : Tokens.TypeScale.base, .medium)).foregroundColor(Theme.tint(tint)))
                .padding(1)
        } else if let img = icons.image(item.icon, points: iconSize, scale: scale) {
            Image(nsImage: img).resizable().interpolation(.high)
        } else {
            Color.clear
        }
    }
}

/// The quiet word at a row's right edge: what kind of thing it is.
enum RowKind {
    nonisolated(unsafe) static var types: [String: String] = [:]
    static func label(_ item: ResultItem) -> String? {
        switch item.kind {
        case "app": return "Application"
        case "command", "system": return "Command"
        case "calc": return "Calculator"
        case "setting", "settings": return "System Settings"
        case "mention": return nil
        case "ask": return nil
        case "file":
            let ext = (item.title as NSString).pathExtension.lowercased()
            if ext.isEmpty { return "Folder" }
            if let hit = types[ext] { return hit }
            var name = UTType(filenameExtension: ext)?.localizedDescription ?? ext.uppercased()
            name = name.prefix(1).uppercased() + name.dropFirst()
            types[ext] = name
            return name
        default: return nil
        }
    }
}

/// The Vyre mark: the wire (a V that turns up) and the signal dot, from the 16-unit drawing.
struct MarkView: View {
    let size: CGFloat
    var body: some View {
        Canvas { ctx, sz in
            let k = sz.width / 16
            var wire = Path()
            wire.move(to: CGPoint(x: 2.5 * k, y: 4 * k))
            wire.addLine(to: CGPoint(x: 8 * k, y: 13 * k))
            wire.addLine(to: CGPoint(x: 11.52 * k, y: 7.24 * k))
            ctx.stroke(wire, with: .color(Theme.bone), style: StrokeStyle(lineWidth: 2 * k, lineCap: .round, lineJoin: .round))
            let r = 1.8 * k
            ctx.fill(Path(ellipseIn: CGRect(x: 13.5 * k - r, y: 4 * k - r, width: 2 * r, height: 2 * r)), with: .color(Theme.signal))
        }
        .frame(width: size, height: size)
    }
}
