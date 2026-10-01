// OversightView: the panel itself (team/0.2/capsule-02.html section 11), in Bone tokens on Deep
// glass. The plan with the current step, in-place editing of steps that have not started, the
// person's live words, a field to steer, and Pause and Stop. It is a small view over
// OversightModel and draws only what the running vyred can do.

import SwiftUI

struct OversightView: View {
    @ObservedObject var model: OversightModel
    @ObservedObject private var display = DisplayPrefs.shared
    @Environment(\.colorScheme) private var scheme
    @State private var draft = ""
    @State private var editText = ""
    @FocusState private var editFocus: Bool

    var body: some View {
        Group {
            if let r = model.active {
                VStack(spacing: 0) {
                    grip
                    if model.collapsed { compact(r) } else { full(r) }
                }
                .frame(width: OversightLayout.width)
            }
        }
        .background { Backdrop(reduced: display.reduceTransparency) }
        .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous)
            .strokeBorder(DeepGlass.border(dark: scheme == .dark), lineWidth: DeepGlass.borderWidth))
    }

    /// The three-dot grip: the whole panel drags, this only says so.
    private var grip: some View {
        HStack(spacing: 4) { ForEach(0..<3, id: \.self) { _ in Circle().fill(Theme.ash).frame(width: 3, height: 3) } }
            .frame(maxWidth: .infinity, minHeight: 12)
            .accessibilityHidden(true)
    }

    // MARK: full

    private func full(_ r: OversightRun) -> some View {
        let v = OversightLayout.visible(r)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(r.title).font(Theme.label).foregroundColor(DeepGlass.ink).lineLimit(1)
                Spacer(minLength: 8)
                Text("\(r.done + (r.currentIndex != nil && !r.finished ? 1 : 0)) of \(r.steps.count)")
                    .font(Theme.subtitle).foregroundColor(Theme.stone)
                Button { model.collapsed = true } label: { Image(systemName: "chevron.up").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundColor(Theme.stone).help("Make it small")
                    .accessibilityLabel("Make the panel small")
            }
            .padding(.horizontal, 14).frame(height: OversightLayout.header - 12)

            VStack(alignment: .leading, spacing: 0) {
                if v.before > 0 { moreRow("\(v.before) earlier") }
                ForEach(v.steps) { s in step(s, number: (r.steps.firstIndex(of: s) ?? 0) + 1) }
                if v.after > 0 { moreRow("\(v.after) to go") }
            }
            .padding(.horizontal, 8).padding(.bottom, 12)

            if let said = r.voice {
                HStack(spacing: 8) {
                    Circle().fill(Theme.signal).frame(width: 7, height: 7)
                    Text("\u{201C}\(said)\u{201D}").font(Theme.subtitle).foregroundColor(DeepGlass.ink.opacity(DeepGlass.draftOpacity)).lineLimit(2)
                }
                .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: OversightLayout.voice, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(Theme.rule).frame(height: 1) }
            }
            if model.canSteer { prompt }
            controls(r)
            if let l = model.line {
                Text(l).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1)
                    .padding(.horizontal, 14).frame(height: OversightLayout.line, alignment: .leading)
            }
        }
    }

    private func moreRow(_ s: String) -> some View {
        Text(s).font(Theme.subtitle).foregroundColor(Theme.ash)
            .padding(.leading, 30).frame(height: OversightLayout.more, alignment: .leading)
    }

    private func step(_ s: OversightStep, number: Int) -> some View {
        let current = s.state == .current
        return HStack(alignment: .top, spacing: 10) {
            ZStack {
                Circle().strokeBorder(current ? Theme.signal : Theme.rule, lineWidth: current ? 2 : 1)
                switch s.state {
                case .done: Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.stone)
                case .failed: Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.ash)
                case .skipped: Image(systemName: "minus").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.ash)
                default: Text("\(number)").font(Theme.subtitle).foregroundColor(current ? DeepGlass.ink : Theme.stone)
                }
            }
            .frame(width: 18, height: 18)
            if model.editing == s.id {
                TextField("", text: $editText, axis: .vertical)
                    .textFieldStyle(.plain).font(Theme.subtitle).foregroundColor(DeepGlass.ink)
                    .focused($editFocus).lineLimit(1...2)
                    .onSubmit { model.edit(step: s.id, to: editText) }
                    .onExitCommand { model.editing = nil }
            } else {
                Text(s.text).font(Theme.subtitle)
                    .foregroundColor(s.state == .done || s.state == .skipped ? Theme.stone : DeepGlass.ink)
                    .strikethrough(s.state == .skipped, color: Theme.ash)
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    .onTapGesture(count: 2) { beginEdit(s) }
                if s.editable && model.canEdit {
                    Button { beginEdit(s) } label: { Image(systemName: "pencil").font(.system(size: 10)) }
                        .buttonStyle(.plain).foregroundColor(Theme.ash).help("Change this step")
                        .accessibilityLabel("Change step \(number)")
                }
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 6)
        .frame(minHeight: OversightLayout.rowHeight(s), alignment: .top)
        .background(current ? RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).fill(Theme.signal.opacity(0.14)) : nil)
        .accessibilityElement(children: .combine)
    }

    private func beginEdit(_ s: OversightStep) {
        guard s.editable, model.canEdit else { return }
        editText = s.text
        model.editing = s.id
        editFocus = true
    }

    private var prompt: some View {
        HStack(spacing: 8) {
            TextField("Tell it what to change...", text: $draft)
                .textFieldStyle(.plain).font(Theme.subtitle).foregroundColor(DeepGlass.ink)
                .onSubmit { model.steer(draft); draft = "" }
                .onExitCommand { model.stop() }
            Text("\u{23CE} send \u{00B7} Esc stop").font(Theme.subtitle).foregroundColor(Theme.ash)
        }
        .padding(.horizontal, 10).frame(height: 30)
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
        .padding(.horizontal, 12).padding(.bottom, 14).padding(.top, 0)
        .frame(height: OversightLayout.prompt, alignment: .bottom)
    }

    private func controls(_ r: OversightRun) -> some View {
        HStack(spacing: 8) {
            if model.canPause {
                Button(r.paused ? "Resume" : "Pause") { model.pause() }
                    .buttonStyle(OversightButton(primary: r.paused))
            }
            Button("Stop") { model.stop() }.buttonStyle(OversightButton(primary: false, quiet: true))
            Spacer(minLength: 0)
            if r.paused { Text("Paused").font(Theme.subtitle).foregroundColor(Theme.attention) }
            else if model.canEdit { Text("Editable any time").font(Theme.subtitle).foregroundColor(Theme.ash) }
        }
        .padding(.horizontal, 12).frame(height: OversightLayout.controls)
        .overlay(alignment: .top) { Rectangle().fill(Theme.rule).frame(height: 1) }
    }

    // MARK: compact

    private func compact(_ r: OversightRun) -> some View {
        let cur = r.currentIndex.map { r.steps[$0] }
        return HStack(spacing: 8) {
            Circle().fill(r.paused ? Theme.attention : Theme.signal).frame(width: 8, height: 8)
            Text(r.paused ? "Paused" : (cur?.text ?? r.title)).font(Theme.subtitle)
                .foregroundColor(DeepGlass.ink).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text("\((r.currentIndex ?? r.steps.count - 1) + 1)/\(r.steps.count)").font(Theme.subtitle).foregroundColor(Theme.stone)
            Button { model.collapsed = false } label: { Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)) }
                .buttonStyle(.plain).foregroundColor(Theme.stone).help("Show the plan")
                .accessibilityLabel("Show the plan")
        }
        .padding(.horizontal, 14).frame(height: OversightLayout.compactHeight - 12)
    }
}

/// Pause is an outline; Stop is plain text. Neither is the loud one: nothing here asks the person
/// to hurry.
struct OversightButton: ButtonStyle {
    var primary: Bool
    var quiet = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.label)
            .foregroundColor(DeepGlass.ink)
            .padding(.horizontal, 12).frame(height: 26)
            .background(RoundedRectangle(cornerRadius: Tokens.Radius.button, style: .continuous)
                .fill(primary ? Theme.signal.opacity(0.22) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.button, style: .continuous)
                .strokeBorder(quiet ? Color.clear : Theme.ruleStrong, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
