import SwiftUI

/// The cards a session draws inline (phone.md section 6): the approval card for an ask, the same
/// card with choices for a question, and a held draft. Neutral: `--panel`, a `--rule-strong`
/// border, radius 12, 14 padding, 10 between parts; the attention colour is only the dot and the
/// "is waiting on you" label. "Details" opens the detail sheet.
struct CardShell<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.ruleStrong, lineWidth: 1) }
    }
}

/// "<agent> is waiting on you", and Details on the right.
struct WaitingHead: View {
    @Environment(AppModel.self) private var app
    let agent: String
    let ref: String

    var body: some View {
        HStack(spacing: Space.s) {
            Dot(color: .beaconDot, size: 7)
            Text("\(agent) is waiting on you").vyre(.small, weight: 600).foregroundStyle(Color.beaconInk).lineLimit(1)
            Spacer(minLength: Space.s)
            Button { app.detail = DetailRef(id: ref) } label: {
                Text("Details").vyre(.small, weight: 600).foregroundStyle(Color.text)
                    .frame(minWidth: Space.target, minHeight: Space.target)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -Space.m)
        }
    }
}

/// A command in a card: `--bg`, radius 6, 10 x 12, mono 14/20, `$` in `--label` for a command.
struct CommandBlock: View {
    let text: String
    var prompt = true
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            if prompt { Text("$").vyre(.code).foregroundStyle(Color.label) }
            Text(text).vyre(.code).foregroundStyle(Color.text).lineLimit(6).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(Color.bg, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// One line of facts under a card's command: "6 files +412 -38 · harlow-legal/reports".
func cardFacts(_ a: AskItem) -> String {
    var bits: [String] = []
    if let c = a.detail["commits"].int, c > 0 { bits.append(c == 1 ? "1 commit" : "\(c) commits") }
    if let ch = ChangeSet(changes: a.detail["changes"], totals: a.detail["totals"]) { bits.append(ch.summary) }
    if let d = a.destination, !d.isEmpty, d != a.summary { bits.append(d) }
    return bits.joined(separator: " · ")
}

/// A permission ask in its session: the command, one line of facts, then Deny and Approve.
struct ApprovalCard: View {
    @Environment(AppModel.self) private var app
    let ask: AskItem
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        let item = NeedItem.ask(ask)
        CardShell {
            WaitingHead(agent: ask.agent ?? app.assistantLabel, ref: item.id)
            CommandBlock(text: ask.summary.isEmpty ? ask.tool : ask.summary, prompt: ask.isCommand)
            let facts = cardFacts(ask)
            if !facts.isEmpty { Text(facts).vyre(.small).foregroundStyle(Color.text2).lineLimit(2) }
            if let problem { FailedLine(text: problem) }
            HStack(spacing: Space.s) {
                Button("Deny") { Task { await decide(.deny) } }
                    .buttonStyle(.vyre(.secondary, fill: true))
                    .disabled(busy)
                Button { Task { await decide(.allow) } } label: { PrimaryLabel(text: "Approve", faceID: item.faceID) }
                    .buttonStyle(.vyre(.primary, fill: true))
                    .disabled(busy)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func decide(_ d: AskDecision) async {
        busy = true
        defer { busy = false }
        problem = nil
        do { try await app.needs.answer(ask, d) }
        catch where isCancel(error) {}
        catch { problem = describe(error) }
    }
}

/// A question in its session: the same card, the choices as rows inside it, Later and Answer.
struct QuestionCard: View {
    @Environment(AppModel.self) private var app
    let ask: AskItem
    @State private var picks: [QuestionPick] = []
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        let item = NeedItem.question(ask)
        CardShell {
            WaitingHead(agent: ask.agent ?? app.assistantLabel, ref: item.id)
            ForEach(Array(ask.questions.enumerated()), id: \.offset) { i, q in
                QuestionBlock(q: q, pick: Binding(get: { i < picks.count ? picks[i] : QuestionPick() },
                                                  set: { v in if i < picks.count { picks[i] = v } }), compact: true)
            }
            if let problem { FailedLine(text: problem) }
            HStack(spacing: Space.s) {
                Button("Later") { Task { await decide(.deny) } }
                    .buttonStyle(.vyre(.secondary, fill: true))
                    .disabled(busy)
                Button { Task { await answer() } } label: { PrimaryLabel(text: "Answer", faceID: item.faceID) }
                    .buttonStyle(.vyre(.primary, fill: true))
                    .disabled(busy || QuestionPick.answers(ask.questions, picks) == nil)
            }
        }
        .onAppear { if picks.count != ask.questions.count { picks = ask.questions.map { _ in QuestionPick() } } }
    }

    private func answer() async {
        guard let a = QuestionPick.answers(ask.questions, picks) else { return }
        await decide(.answers(a))
    }

    private func decide(_ d: AskDecision) async {
        busy = true
        defer { busy = false }
        problem = nil
        do { try await app.needs.answer(ask, d) }
        catch where isCancel(error) {}
        catch { problem = describe(error) }
    }
}

/// A draft held at the Gate in its session: who it goes to and what it says, Discard, and Review,
/// which opens the sheet with its final words and Send (a send never goes out unseen).
struct HeldCard: View {
    @Environment(AppModel.self) private var app
    let draft: HeldDraft

    var body: some View {
        let item = NeedItem.held(draft)
        CardShell {
            WaitingHead(agent: draft.agent ?? app.assistantLabel, ref: item.id)
            Text(item.title).vyre(.rowTitle).foregroundStyle(Color.text)
            if !item.line2.isEmpty { Text(item.line2).vyre(.secondary).foregroundStyle(Color.text2).lineLimit(2) }
            if let err = draft.error { FailedLine(text: "Held again: \(err)") }
            HStack(spacing: Space.s) {
                Button("Discard") { app.needs.dismiss(item) }
                    .buttonStyle(.vyre(.secondary, fill: true))
                Button("Review") { app.detail = DetailRef(id: item.id) }
                    .buttonStyle(.vyre(.primary, fill: true))
            }
        }
    }
}

/// An answered ask, as one Meta line: "Approved by you, 12:07".
struct AnsweredLine: View {
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.label).accessibilityHidden(true)
            Text(text).vyre(.small).foregroundStyle(Color.label)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
