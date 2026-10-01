// CommandRunView: what `vyre ...` said, drawn natively (Host/CommandRun.swift): tables, cards,
// status checks, a QR code, a prompt for what to add, or the error and what to do next. It grows,
// then scrolls, like an answer.

import SwiftUI

struct CommandRunView: View {
    @ObservedObject var run: CommandRun
    let scroller: AnswerScroller
    let cap: CGFloat

    var body: some View {
        AnswerScroll(scroller: scroller, cap: cap, grows: run.views.count + (run.running ? 0 : 1), answerID: run.title) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "terminal").font(Theme.type(Tokens.TypeScale.base, .medium)).foregroundColor(Theme.stone)
                    Text(run.title).font(Theme.mono).foregroundColor(Theme.bone).lineLimit(1).truncationMode(.middle)
                    Text(state).font(Theme.type(Tokens.TypeScale.meta)).foregroundColor(Theme.ash)
                    Spacer()
                }
                if let f = run.failure { Label(f, systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
                ForEach(Array(run.views.enumerated()), id: \.offset) { _, v in view(v) }
                if !run.running, run.views.isEmpty, run.failure == nil {
                    Text(run.exit == 0 ? "Done. It said nothing." : "It stopped with nothing to show.").font(Theme.subtitle).foregroundColor(Theme.stone)
                }
            }
            .padding(.horizontal, Theme.inset).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var state: String {
        if run.running { return "running" }
        switch run.exit {
        case 0?: return "done"
        case 2?: return "usage"
        case 3?: return "needs you"
        case 4?: return "vault locked"
        case 5?: return "Vyre down"
        case let c?: return "failed (\(c))"
        case nil: return run.failure == nil ? "stopped" : "failed"
        }
    }

    @ViewBuilder private func view(_ v: CLIView) -> some View {
        switch v {
        case .text(let lines):
            Text(lines.joined(separator: "\n")).font(Theme.mono).foregroundColor(Theme.bone)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        case .card(let title, let fields, let st):
            VStack(alignment: .leading, spacing: 6) {
                HStack { Text(title).font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.bone); if let st { Text(st).font(Theme.type(Tokens.TypeScale.meta)).foregroundColor(Theme.ash) } }
                ForEach(Array(fields.enumerated()), id: \.offset) { _, f in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(f.label).font(Theme.type(Tokens.TypeScale.meta)).foregroundColor(Theme.ash).frame(width: 140, alignment: .leading)
                        Text(f.value).font(Theme.type(Tokens.TypeScale.base)).foregroundColor(Theme.bone).textSelection(.enabled)
                    }
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous).fill(Theme.raised))
        case .table(let columns, let rows, let empty):
            if rows.isEmpty {
                Text(empty ?? "Nothing to list.").font(Theme.subtitle).foregroundColor(Theme.stone)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    GridRow { ForEach(columns, id: \.key) { c in Text(c.label).font(Theme.type(Tokens.TypeScale.meta, .semibold)).foregroundColor(Theme.ash) } }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        GridRow { ForEach(columns, id: \.key) { c in Text(r[c.key] ?? "").font(Theme.type(Tokens.TypeScale.base)).foregroundColor(Theme.bone).lineLimit(1).truncationMode(.tail) } }
                    }
                }
            }
        case .checks(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.id) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: i.state == "ok" ? "checkmark.circle" : i.state == "failed" ? "xmark.circle" : i.state == "wait" ? "clock" : "questionmark.circle")
                            .foregroundColor(i.state == "ok" ? Theme.signal : Theme.stone)
                        Text(i.label).font(Theme.type(Tokens.TypeScale.base)).foregroundColor(Theme.bone)
                        if let n = i.note { Text(n).font(Theme.type(Tokens.TypeScale.meta)).foregroundColor(Theme.ash) }
                    }
                }
            }
        case .qr(let text, let caption):
            HStack(alignment: .top, spacing: 16) {
                if let img = CLIRun.qrImage(text) {
                    Image(nsImage: img).interpolation(.none).resizable().frame(width: 180, height: 180)
                        .padding(8).background(RoundedRectangle(cornerRadius: Tokens.Radius.field).fill(Color.white))
                        .accessibilityLabel("QR code\(caption.map { ": " + $0 } ?? "")")
                }
                if let caption { Text(caption).font(Theme.type(Tokens.TypeScale.base)).foregroundColor(Theme.stone) }
            }
        case .prompt(let name, let label, let choices, _):
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.bone)
                Text(choices.isEmpty ? "Add \(name) to the command in the box and press Return." : "Add one of: \(choices.joined(separator: ", ")), then press Return.")
                    .font(Theme.subtitle).foregroundColor(Theme.stone)
            }
        case .error(_, let message, let next):
            VStack(alignment: .leading, spacing: 4) {
                Label(message, systemImage: "xmark.circle").font(Theme.type(Tokens.TypeScale.base)).foregroundColor(Theme.bone)
                if let next { Text(next).font(Theme.subtitle).foregroundColor(Theme.stone) }
            }
        }
    }
}
