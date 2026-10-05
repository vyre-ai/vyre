// IQCardViews: Vyre IQ's source chips and its "Wrong?" correction panel (capsule.md "The card",
// team/archive/work-journals/capsule-pro.md 3/3a). Small hooks into CapsuleView.swift call these; the state lives
// in CapsuleModel (IQAsk.swift). Nothing here sends anything until a button or the field's Enter.

import SwiftUI

/// Up to three source chips for a Vyre IQ answer, then "+N more"; the confidence line stays
/// separate (capsule.md: "sources[] | up to 3 source chips, then '+2 more'"). Each chip is 28
/// tall, radius 14, 1 px ruleStrong, 13/18 text2, its key hint (⌘1..⌘3) at the end.
struct IQSourceChips: View {
    let memory: MemoryAnswer
    var open: (Int) -> Void

    var body: some View {
        let items = Array(memory.sources.prefix(3).enumerated())
        HStack(spacing: 6) {
            ForEach(items, id: \.offset) { i, s in IQSourceChip(source: s, key: i + 1) { open(i) } }
            let more = memory.sources.count - items.count
            if more > 0 { Text("+\(more) more").font(Theme.subtitle).foregroundColor(Theme.ash) }
        }
    }
}

private struct IQSourceChip: View {
    let source: MemorySource
    let key: Int
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(source.name).lineLimit(1)
                if !source.age.isEmpty { Text("·").foregroundColor(Theme.ash); Text(Memo.ago(source.age)) }
                Text("⌘\(key)").foregroundColor(Theme.ash)
            }
            .font(Theme.title).foregroundColor(Theme.stone)
            .padding(.horizontal, 10).frame(height: 28)
            .fixedSize()
            .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(source.quote)
        .accessibilityLabel("Source \(key), \(source.name)\(source.age.isEmpty ? "" : ", " + Memo.ago(source.age))")
    }
}

/// The quiet "Wrong?" line under an answered IQ card (95b2b891): opens the correction panel below it.
struct IQWrongLine: View {
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            Text("Wrong?").font(Theme.subtitle).foregroundColor(Theme.ash)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Correct this answer")
    }
}

/// The three choices open in place (95b2b891): "That's wrong", "Forget this", and a field for the
/// right answer (Enter: action "replace"). A "not sure" card (`hadAnswer` false) shows the field
/// only, "Know it? Tell me". Nothing is sent until a button or Enter; no Touch ID.
struct IQCorrectPanel: View {
    let state: IQCorrecting
    var onWrong: () -> Void
    var onForget: () -> Void
    var onReplace: (String) -> Void
    var onCancel: () -> Void
    @State private var text: String

    init(state: IQCorrecting, onWrong: @escaping () -> Void, onForget: @escaping () -> Void,
         onReplace: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.state = state; self.onWrong = onWrong; self.onForget = onForget; self.onReplace = onReplace; self.onCancel = onCancel
        _text = State(initialValue: state.draft)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if state.hadAnswer {
                HStack(spacing: 14) {
                    Button("That's wrong", action: onWrong).buttonStyle(.plain).font(Theme.subtitle).foregroundColor(Theme.stone)
                    Button("Forget this", action: onForget).buttonStyle(.plain).font(Theme.subtitle).foregroundColor(Theme.stone)
                    Spacer()
                    Button("Cancel", action: onCancel).buttonStyle(.plain).font(Theme.subtitle).foregroundColor(Theme.ash)
                }
            }
            HStack(spacing: 8) {
                TextField(state.hadAnswer ? "Or the right answer" : "Know it? Tell me", text: $text)
                    .textFieldStyle(.plain)
                    .font(Theme.title).foregroundColor(Theme.bone)
                    .onSubmit {
                        let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !v.isEmpty { onReplace(v) }
                    }
                if !state.hadAnswer {
                    Button("Cancel", action: onCancel).buttonStyle(.plain).font(Theme.subtitle).foregroundColor(Theme.ash)
                }
            }
            .padding(.horizontal, 10).frame(height: 28)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.ruleStrong, lineWidth: 1))
        }
        .padding(.top, 6)
    }
}

/// A correction just applied: the corrected answer already shows above; this is the quiet
/// "Undo" beside a word for what happened.
struct IQFixedLine: View {
    let fix: IQFixShown
    let onUndo: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Text(fix.action == "replace" ? "Corrected." : fix.action == "wrong" ? "Marked wrong." : "Forgotten.")
                .font(Theme.subtitle).foregroundColor(Theme.ash)
            Button("Undo", action: onUndo).buttonStyle(.plain).font(Theme.subtitle).foregroundColor(Theme.stone)
        }
    }
}

/// "you corrected this": drawn instead of source chips when memory.ask answers via "corrected"
/// (its one source, "fix:<n>", is provenance, never a chip).
struct IQCorrectedLine: View {
    var body: some View {
        Text("you corrected this").font(Theme.subtitle).foregroundColor(Theme.ash)
    }
}
