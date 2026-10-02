// HistoryImportView: the side panel for bringing this Mac's history in (#26). It is a small view over
// HistoryImportModel: what was found, a tick for each project, the exact plan and the two choices that
// are the person's (how fast, and just these or new ones too), then the sending with Stop. Plain words
// only: no tool names, no ids, no folder paths beyond the folder's own name.

import SwiftUI

struct HistoryImportView: View {
    @ObservedObject var model: HistoryImportModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Bring your history in").font(Theme.label).foregroundColor(Theme.bone)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .idle:
            note("Vyre can read the Claude Code, Codex and Grok sessions on this Mac and keep them in your own Vyre, so they are searchable everywhere. You choose what comes in.")
            primary("Look for sessions") { Task { await model.scan() } }
        case .scanning, .planning:
            note(model.step == .scanning ? "Looking on this Mac…" : "Counting what that takes…")
        case .unpaired:
            note(model.foundLine)
        case .nothing:
            note(model.foundLine)
            secondary("Look again") { Task { await model.scan() } }
        case .choose:
            choose
        case .confirm:
            confirm
        case .sending:
            sending
        case .done:
            note(model.doneLine)
        case .failed(let why):
            note("That did not finish. \(why)")
            secondary("Start over") { Task { await model.scan() } }
        }
    }

    // MARK: choose

    private var choose: some View {
        VStack(alignment: .leading, spacing: 10) {
            note(model.foundLine)
            if let d = model.keepsDays {
                note("Claude Code keeps sessions for \(d) days by default, so older ones may already be gone.")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(model.sources) { s in source(s) }
                }
            }
            .frame(maxHeight: 280)
            HStack(spacing: 10) {
                Text("\(model.tickedSessions) of \(model.totalSessions) chosen").font(Theme.subtitle).foregroundColor(Theme.stone)
                Spacer()
                Button("All") { model.tickAll(true) }.buttonStyle(.plain).foregroundColor(Theme.stone).font(Theme.subtitle)
                Button("None") { model.tickAll(false) }.buttonStyle(.plain).foregroundColor(Theme.stone).font(Theme.subtitle)
            }
            primary("See what that takes", enabled: model.tickedSessions > 0) { Task { await model.makePlan() } }
        }
    }

    private func source(_ s: HistorySource) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(s.label).font(Theme.label).foregroundColor(Theme.bone)
                Spacer()
                Text(sub(s.sessions, s.bytes, s.from, s.to)).font(Theme.subtitle).foregroundColor(Theme.ash)
            }
            ForEach(s.folders) { f in
                Toggle(isOn: Binding(get: { model.ticked.contains(f.id) }, set: { _ in model.toggle(f) })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(f.name).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                        Text(f.why.map { "Not suggested: \($0). " }.map { $0 + sub(f.sessions, f.bytes, f.from, f.to) } ?? sub(f.sessions, f.bytes, f.from, f.to))
                            .font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
                    }
                }
                .toggleStyle(.checkbox)
                .accessibilityLabel("\(f.name), \(f.sessions) sessions")
            }
        }
    }

    private func sub(_ n: Int, _ bytes: Int, _ from: Date?, _ to: Date?) -> String {
        let r = HistoryImportModel.range(from, to)
        return [ "\(n) \(n == 1 ? "session" : "sessions")", HistoryImportModel.size(bytes), r ].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: confirm

    @ViewBuilder private var confirm: some View {
        if let p = model.plan {
            VStack(alignment: .leading, spacing: 10) {
                note("That is \(p.sessions) \(p.sessions == 1 ? "session" : "sessions") in \(p.folders) \(p.folders == 1 ? "project" : "projects"), \(HistoryImportModel.size(p.bytes)). Search works as soon as they arrive. Understanding them, who is in them and what they say, takes:")
                choice("How fast", [(HistoryPace.fast, "Fast: \(HistoryImportModel.fastWords(p.fastHours)). Uses more of your plan's normal limits today."),
                                    (HistoryPace.gentle, "Gentle: \(HistoryImportModel.gentleWords(p.gentleDays)).")], selection: $model.pace)
                choice("What to send", [(HistoryMode.once, "Just these sessions."),
                                        (HistoryMode.sync, "These, and new ones as they appear.")], selection: $model.mode)
                note("Nothing extra is ever charged. You can stop at any time; what was already sent stays.")
                HStack {
                    secondary("Back") { model.back() }
                    primary("Send them", enabled: model.canStart) { Task { await model.start() } }
                }
            }
        }
    }

    private func choice<T: Hashable>(_ title: String, _ options: [(T, String)], selection: Binding<T?>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Theme.label).foregroundColor(Theme.stone)
            ForEach(options.indices, id: \.self) { i in
                let opt = options[i]
                Button { selection.wrappedValue = opt.0 } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: selection.wrappedValue == opt.0 ? "largecircle.fill.circle" : "circle").foregroundColor(Theme.stone)
                        Text(opt.1).font(Theme.title).foregroundColor(Theme.bone).multilineTextAlignment(.leading)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection.wrappedValue == opt.0 ? .isSelected : [])
            }
        }
    }

    // MARK: sending

    private var sending: some View {
        VStack(alignment: .leading, spacing: 10) {
            note(model.sendingLine)
            if let u = model.upload, u.total > 0 {
                ProgressView(value: Double(min(u.done, u.total)), total: Double(u.total))
            }
            if model.searchable > 0 { note("\(model.searchable) searchable so far.") }
            secondary("Stop") { Task { await model.stop() } }
        }
    }

    // MARK: pieces

    private func note(_ s: String) -> some View {
        Text(s).font(Theme.title).foregroundColor(Theme.stone).fixedSize(horizontal: false, vertical: true)
    }

    private func primary(_ title: String, enabled: Bool = true, _ run: @escaping () -> Void) -> some View {
        Button(title, action: run).buttonStyle(.borderedProminent).disabled(!enabled)
    }

    private func secondary(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(title, action: run).buttonStyle(.bordered)
    }
}
