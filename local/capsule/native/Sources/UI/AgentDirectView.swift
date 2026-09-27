// AgentDirect: the conversation with an agent, drawn from Direct. History oldest first, the reply
// streaming into it, the agent's open asks in violet attention (a click opens the card), and vyred's own
// notices as one faint line (rule 3).

import SwiftUI

struct DirectView: View {
    @ObservedObject var direct: Direct
    @ObservedObject var desk: Desk

    var body: some View {
        if let d = direct.dm {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Direct").font(Theme.label).foregroundColor(Theme.signal)
                    Text(d.agent).font(Theme.title).foregroundColor(Theme.stone)
                    Spacer()
                    Text(DirectView.state(d)).font(Theme.subtitle).foregroundColor(Theme.ash)
                }
                .padding(.horizontal, Theme.inset).frame(height: CapsuleLayout.lineHeight)
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 10) {
                            if d.messages.isEmpty, !d.loading {
                                Text("Nothing with \(d.agent) yet. What you send starts it.").font(Theme.subtitle).foregroundColor(Theme.ash)
                            }
                            ForEach(d.messages.suffix(20)) { m in message(m, agent: d.agent).id(m.id) }
                        }
                        .padding(.horizontal, Theme.inset).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: DirectView.listHeight(d))
                    .onChange(of: d.messages.last?.text) { if let id = d.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                    .onAppear { if let id = d.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                }
                ForEach(d.asks, id: \.key) { w in
                    WaitingRow(w: w, selected: false).contentShape(Rectangle()).onTapGesture { desk.openCard(w) }
                }
                if let n = d.notice, !n.isEmpty {
                    Text(n).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(2).padding(.horizontal, Theme.inset).frame(height: Tokens.TypeScale.read.line, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder private func message(_ m: DmMessage, agent: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(m.role == .user ? (m.surface.map { "You · \($0)" } ?? "You") : agent)
                .font(Theme.label).foregroundColor(m.role == .agent ? Theme.signal : Theme.ash)
            if let tools = m.tools, !tools.isEmpty { ToolRows(tools: tools) }
            Text(DirectView.markdown(m.text + (m.role == .agent && m.done != true && m.error == nil ? " …" : "")))
                .font(Theme.reply).foregroundColor(Theme.bone).textSelection(.enabled)
            if let e = m.error { Label("Failed. \(e)", systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
        }
        .opacity(m.pending ? 0.6 : 1)
    }

    static func state(_ d: Dm) -> String {
        if d.loading { return "loading" }
        if let h = d.holder, h != "capsule" { return "\(h) has the keyboard" }
        return d.busy ? "working" : ""
    }

    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    static func listHeight(_ d: Dm) -> CGFloat {
        if d.messages.isEmpty { return 34 }
        let lines = d.messages.suffix(20).reduce(0) { $0 + 1 + $1.text.count / 78 + 1 + ($1.tools?.count ?? 0) }
        return min(280, CGFloat(lines) * 19 + 12)
    }

}
