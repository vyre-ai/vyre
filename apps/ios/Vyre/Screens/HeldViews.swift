import SwiftUI

/// One field of a held item. It reads as text; a tap makes it editable where it stands. There is
/// no Edit button: what the person reads is what they change (floor rule 1).
struct InPlaceField: View {
    @Binding var field: HeldField
    var compact = false
    @State private var editing = false
    @FocusState private var focused: Bool

    var body: some View {
        let isBody = field.key == "body"
        VStack(alignment: .leading, spacing: Space.xs) {
            if !isBody || compact {
                HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                    Engraved(field.label).frame(width: 64, alignment: .leading)
                    value(role: field.key == "to" || field.key == "url" || field.key == "method" ? .code : .body)
                }
            } else {
                value(role: .body)
                    .padding(Space.gutter)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.panel))
            }
        }
        .padding(.vertical, isBody && !compact ? Space.s : Space.m)
        .overlay(alignment: .bottom) { if !isBody || compact { Hairline() } }
        .onChange(of: focused) { _, f in if !f { editing = false } }
    }

    @ViewBuilder
    private func value(role: TypeRole) -> some View {
        let r: TypeRole = field.isJSON ? .code : role
        if editing {
            TextField("", text: $field.value, axis: .vertical)
                .vyre(r)
                .foregroundStyle(Color.bone)
                .textInputAutocapitalization(field.key == "to" || field.key == "url" || field.isJSON ? .never : .sentences)
                .autocorrectionDisabled(field.key == "to" || field.key == "url" || field.isJSON)
                .focused($focused)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.signal).frame(height: 2).offset(y: 4) }
                .accessibilityLabel("\(field.label), editing")
        } else {
            Text(field.value.isEmpty ? "Empty" : field.value)
                .vyre(r)
                .foregroundStyle(field.value.isEmpty ? Color.ash : Color.bone)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture {
                    editing = true
                    focused = true
                }
                .overlay(alignment: .topTrailing) {
                    if field.changed { Engraved("edited", color: .signal).offset(y: -2) }
                }
                .accessibilityLabel("\(field.label): \(field.value)")
                .accessibilityHint("Double-tap to edit")
                .accessibilityAddTraits(.isButton)
        }
    }
}

/// The body of a held item: its fields in place, the failed-send line, and the two buttons.
/// Used by the Now detail screen and by the inline card in a thread.
struct HeldBody: View {
    @Environment(AppModel.self) private var app
    @State var draft: HeldDraft
    var compact = false
    var done: (() -> Void)?
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach($draft.fields) { $f in InPlaceField(field: $f, compact: compact) }
            if let err = draft.error ?? problem {
                Text(draft.error != nil ? "Held again: \(err)" : err)
                    .vyre(.small).foregroundStyle(Color.beacon)
                    .padding(.vertical, Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: Space.s) {
                Button { Task { await approve() } } label: {
                    Label(draft.primaryLabel, systemImage: "arrow.right")
                }
                .buttonStyle(.vyre(.primary, fill: true))
                .disabled(busy)
                Button("Discard") { Task { await discard() } }
                    .buttonStyle(.secondary)
                    .disabled(busy)
            }
            .padding(.top, Space.m)
        }
        .onChange(of: draft) { _, d in app.needs.update(d) }
    }

    private func approve() async {
        busy = true
        defer { busy = false }
        problem = nil
        do {
            if let err = try await app.needs.approve(draft) {
                draft.error = err
                Haptics.warning()
            } else {
                done?()
            }
        } catch let e as VyreError where e == .cancelled {
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    private func discard() async {
        busy = true
        defer { busy = false }
        do {
            try await app.needs.discard(draft)
            done?()
        } catch let e as VyreError where e == .cancelled {
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

/// The full-screen held item, reached from Now: the board's PhoneDraft.
struct HeldDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let draft: HeldDraft

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.l) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(draft.title).vyre(.h2).foregroundStyle(Color.bone)
                    Text(subtitle).vyre(.small).foregroundStyle(Color.stone)
                }
                HeldBody(draft: draft) { dismiss() }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { EmptyView() }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: Space.s) { Dot(color: .beacon); Engraved("Held at the Gate", color: .beacon) }
            }
        }
        .vyreNavBar()
    }

    private var subtitle: String {
        let who = draft.agent ?? "An agent"
        let when = age(draft.at)
        let what = draft.kind == "send" ? "It waits here until you send it." : "It waits here until you approve it."
        return "\(who) wrote this \(when.isEmpty ? "just now" : when + " ago"). \(what)"
    }
}

/// A permission ask as a card: what it wants to run, where, and Allow / Deny.
struct AskCard: View {
    @Environment(AppModel.self) private var app
    let ask: AskItem
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                HStack(spacing: Space.s) { Dot(color: .beacon); Engraved("Permission", color: .beacon) }
                Spacer()
                Text([ask.agent, age(ask.at)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .vyre(.codeSmall).foregroundStyle(Color.stone)
            }
            Text(ask.isCommand ? "May I run" : "May I use \(ask.tool)").vyre(.title).foregroundStyle(Color.bone)
            Text(ask.summary).vyre(.code).foregroundStyle(Color.bone)
                .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.codeGround, in: RoundedRectangle(cornerRadius: Radius.button))
            if let d = ask.destination, !d.isEmpty, d != ask.summary {
                Text(d).vyre(.codeSmall).foregroundStyle(Color.stone)
            }
            if let r = ask.reason, !r.isEmpty { Text(r).vyre(.small).foregroundStyle(Color.stone) }
            if let problem { Text(problem).vyre(.small).foregroundStyle(Color.beacon) }
            HStack(spacing: Space.s) {
                Button("Allow") { Task { await answer(true) } }.buttonStyle(.vyre(.primary, fill: true)).disabled(busy)
                Button("Deny") { Task { await answer(false) } }.buttonStyle(.secondary).disabled(busy)
            }
        }
        .padding(Space.gutter)
        .background(Color.beaconWash, in: RoundedRectangle(cornerRadius: Radius.panel))
    }

    private func answer(_ allow: Bool) async {
        busy = true
        defer { busy = false }
        do { try await app.needs.answer(ask, allow: allow) }
        catch let e as VyreError where e == .cancelled {}
        catch { problem = (error as? LocalizedError)?.errorDescription ?? "\(error)" }
    }
}
