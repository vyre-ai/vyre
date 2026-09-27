import SwiftUI

/// Which item the detail sheet shows: a Needs you row's id ("h-", "a-" or "q-" and the box's id).
struct DetailRef: Identifiable, Hashable {
    let id: String
}

/// A diff summary, when the box sends one (phone.md section 15, queued with chat): `changes:
/// [{file, added, removed}]` and `totals: {files, added, removed}`. The Changes row reads the
/// totals, or sums `changes` when there are none; with neither the row is left out.
struct ChangeSet: Equatable, Sendable {
    struct File: Equatable, Sendable, Hashable, Identifiable {
        let file: String
        let added: Int
        let removed: Int
        /// The file's diff, when the box sends one (`diff` or `patch`).
        let diff: String?
        var id: String { file }
    }

    let files: [File]
    let fileCount: Int
    let added: Int
    let removed: Int

    init?(changes: JSON, totals: JSON) {
        files = changes.list.compactMap { c in
            c["file"].string.map { File(file: $0, added: c["added"].int ?? 0, removed: c["removed"].int ?? 0, diff: c["diff"].string ?? c["patch"].string) }
        }
        if totals.object != nil {
            fileCount = totals["files"].int ?? files.count
            added = totals["added"].int ?? files.reduce(0) { $0 + $1.added }
            removed = totals["removed"].int ?? files.reduce(0) { $0 + $1.removed }
        } else if !files.isEmpty {
            fileCount = files.count
            added = files.reduce(0) { $0 + $1.added }
            removed = files.reduce(0) { $0 + $1.removed }
        } else {
            return nil
        }
    }

    /// "6 files +412 -38".
    var summary: String { "\(fileCount == 1 ? "1 file" : "\(fileCount) files") +\(added) -\(removed)" }
    var counts: String { "+\(added) -\(removed)" }
}

/// The fact rows of an ask (phone.md section 5): Remote, Branch, Where, Held by, as the box sends
/// them in the ask's detail. Pure, so it is tested.
func askFacts(_ a: AskItem) -> [(String, String)] {
    let d = a.detail
    var out: [(String, String)] = []
    if let r = d["remote"].string, !r.isEmpty { out.append(("Remote", r)) }
    if let b = d["branch"].string, !b.isEmpty { out.append(("Branch", b)) }
    if let w = a.destination, !w.isEmpty, w != a.summary { out.append(("Where", w)) }
    if let h = d["held_by"].string ?? d["rule"].string, !h.isEmpty { out.append(("Held by", h)) }
    return out
}

/// The detail sheet (phone.md section 5), for every Needs you row and a chat's "Details": the
/// large detent, `--panel`, 20 side padding, the header (who asks, the title, how long it has been
/// held, Open session), the body by kind, and the actions pinned above the bottom safe area. Held,
/// ask and question cards are neutral: the attention colour is only the dot and the "Held" label.
struct DetailSheet: View {
    @Environment(AppModel.self) private var app
    let ref: DetailRef
    /// The item as last seen, so one answered elsewhere says so instead of vanishing mid-read.
    @State private var last: NeedItem?

    var body: some View {
        let live = app.needs.item(ref.id)
        Group {
            if let item = live ?? last {
                switch item {
                case .held(let d): DraftDetail(item: item, draft: d, gone: live == nil)
                case .ask(let a): AskDetail(item: item, ask: a, gone: live == nil)
                case .question(let a): QuestionDetail(item: item, ask: a, gone: live == nil)
                }
            } else {
                SheetFrame {
                    SheetHead(item: nil, gone: true)
                } actions: {
                    Button("Close") { app.detail = nil }.buttonStyle(.vyre(.secondary, fill: true, medium: true))
                }
            }
        }
        .onAppear { last = live }
        .onChange(of: live) { _, v in if let v { last = v } }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.panel)
        .presentationCornerRadius(Radius.sheet)
    }
}

/// The sheet's frame: the content scrolls, the actions stay pinned at the bottom.
struct SheetFrame<Content: View, Actions: View>: View {
    @ViewBuilder var content: Content
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) { content }
                    .padding(.horizontal, 20)
                    .padding(.top, Space.l)
                    .padding(.bottom, Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
            VStack(spacing: Space.s) { actions }
                .padding(.horizontal, 20)
                .padding(.top, Space.m)
                .padding(.bottom, Space.s)
                .background(Color.panel)
        }
        .background(Color.panel)
    }
}

/// The header every kind shares: the agent's tile and "<agent> asks · <project>" with the close
/// button; the title in Sheet title; the attention dot with "Held 4 min", and Open session.
struct SheetHead: View {
    @Environment(AppModel.self) private var app
    let item: NeedItem?
    var gone = false

    var body: some View {
        let agent = item?.agent ?? app.assistantLabel
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                if item != nil {
                    Tile(name: agent, size: 22)
                    Text([agent + " asks", item?.project].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .vyre(.small).foregroundStyle(Color.text2).lineLimit(1)
                }
                Spacer(minLength: Space.s)
                Button { app.detail = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.text)
                        .frame(width: 30, height: 30)
                        .background(Color.hover, in: Circle())
                        .overlay { Circle().strokeBorder(Color.rule, lineWidth: 1) }
                        .frame(width: Space.target, height: Space.target)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            Text(item?.title ?? "No longer waiting")
                .vyre(.sheetTitle).foregroundStyle(Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.m)
            HStack(spacing: Space.s) {
                if gone {
                    Text("It was answered somewhere else.").vyre(.secondary).foregroundStyle(Color.label)
                } else if let item {
                    Dot(color: .beaconDot, size: 7)
                    Text(heldFor(item.at)).vyre(.secondary).foregroundStyle(Color.beaconInk)
                }
                Spacer(minLength: Space.s)
                if let item, let thread = item.anchor.thread, !thread.isEmpty {
                    Button { app.openSession(item.anchor) } label: {
                        HStack(spacing: 4) {
                            Text("Open session").vyre(.secondary, weight: 600)
                            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(Color.text)
                        .frame(minHeight: Space.target)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(minHeight: Space.target)
            .padding(.top, Space.xs)
        }
    }

    private func heldFor(_ at: Double) -> String {
        let a = age(at)
        return a.isEmpty || a == "now" ? "Held just now" : "Held \(a)"
    }
}

/// The primary label with the Face ID glyph, only when the box says a proof is needed and no
/// session covers it (the no-nag rule; never guessed from the tool).
struct PrimaryLabel: View {
    let text: String
    let faceID: Bool
    var body: some View {
        HStack(spacing: Space.s) {
            if faceID { Image(systemName: Biometry.glyph).font(.system(size: 20, weight: .regular)) }
            Text(faceID ? "\(text) with \(Biometry.name)" : text)
        }
    }
}

// MARK: ask

/// An ask (a tool call): the command, why the agent wants to, the facts and Changes; Approve,
/// then "Always in <project>" (only when the box offers it) and Deny.
struct AskDetail: View {
    @Environment(AppModel.self) private var app
    let item: NeedItem
    let ask: AskItem
    let gone: Bool
    @State private var busy = false
    @State private var problem: String?
    @State private var changesOpen = false
    @State private var fileOpen: String?
    /// `always_project` as shown. It can arrive a moment after the ask; the button is added then,
    /// but never while a finger is on the buttons (no reflow under the thumb).
    @State private var shownAlways: String?
    @State private var touching = false

    var body: some View {
        SheetFrame {
            SheetHead(item: item, gone: gone)
            command.padding(.top, Space.l)
            if let r = ask.reason, !r.isEmpty {
                Text("Why \(ask.agent ?? app.assistantLabel) wants to").vyre(.label).foregroundStyle(Color.label).padding(.top, Space.l)
                Text(r).vyre(.body).foregroundStyle(Color.text).fixedSize(horizontal: false, vertical: true).padding(.top, Space.xs)
            }
            facts.padding(.top, Space.l)
        } actions: {
            if let problem { FailedLine(text: problem) }
            Button { Task { await decide(.allow) } } label: { PrimaryLabel(text: "Approve", faceID: item.faceID) }
                .buttonStyle(.vyre(.primary, large: true))
                .disabled(busy || gone)
            HStack(spacing: Space.s) {
                if let p = shownAlways {
                    Button("Always in \(p)") { Task { await decide(.alwaysInProject) } }
                        .buttonStyle(.vyre(.secondary, fill: true, medium: true))
                        .disabled(busy || gone)
                }
                Button("Deny") { Task { await decide(.deny) } }
                    .buttonStyle(.vyre(.secondary, fill: true, medium: true))
                    .disabled(busy || gone)
            }
        }
        .simultaneousGesture(DragGesture(minimumDistance: 0)
            .onChanged { _ in touching = true }
            .onEnded { _ in
                touching = false
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    if !touching { shownAlways = ask.alwaysProject }
                }
            })
        .onAppear { shownAlways = ask.alwaysProject }
        .onChange(of: ask.alwaysProject) { _, v in if !touching { shownAlways = v } }
    }

    private var command: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            if ask.isCommand { Text("$").vyre(.code).foregroundStyle(Color.label) }
            Text(ask.summary.isEmpty ? ask.tool : ask.summary).vyre(.code).foregroundStyle(Color.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .background(Color.blockBg, in: RoundedRectangle(cornerRadius: Radius.tile))
        .overlay { RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Color.rule, lineWidth: 1) }
    }

    @ViewBuilder
    private var facts: some View {
        let rows = askFacts(ask)
        let changes = ChangeSet(changes: ask.detail["changes"], totals: ask.detail["totals"])
        if !rows.isEmpty || changes != nil {
            VStack(alignment: .leading, spacing: 0) {
                Hairline()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    DetailFactRow(label: r.0, value: r.1)
                    Hairline()
                }
                if let changes { ChangesRows(changes: changes, open: $changesOpen, file: $fileOpen) }
            }
        }
    }

    private func decide(_ d: AskDecision) async {
        busy = true
        defer { busy = false }
        problem = nil
        if d == .deny {
            // Deny is not destructive: it leaves with Undo, like the swipe.
            app.needs.dismiss(item)
            app.detail = nil
            return
        }
        do {
            try await app.needs.answer(ask, d)
            app.detail = nil
        } catch where isCancel(error) {
        } catch {
            problem = describe(error)
        }
    }
}

/// A fact row: the label on the left in `--label`, the value on the right in `--text`.
struct DetailFactRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Text(label).vyre(.secondary).foregroundStyle(Color.label)
            Spacer(minLength: Space.m)
            Text(value).vyre(.secondary).foregroundStyle(Color.text).multilineTextAlignment(.trailing).lineLimit(3)
        }
        .padding(.vertical, Space.m)
        .frame(minHeight: Space.target)
        .accessibilityElement(children: .combine)
    }
}

/// Changes ("6 files +412 -38"): tap to list the files with their counts; tap a file for its diff
/// (+ lines on `--signal-wash`, - lines on `--del-wash` in `--text-2`).
struct ChangesRows: View {
    let changes: ChangeSet
    @Binding var open: Bool
    @Binding var file: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.18)) { open.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                    Text("Changes").vyre(.secondary).foregroundStyle(Color.label)
                    Spacer(minLength: Space.m)
                    Text(changes.fileCount == 1 ? "1 file" : "\(changes.fileCount) files").vyre(.secondary).foregroundStyle(Color.text)
                    Text(changes.counts).font(VyreFonts.base(.commandRow).asFont(size: 13)).foregroundStyle(Color.text2)
                    if !changes.files.isEmpty {
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.label)
                    }
                }
                .padding(.vertical, Space.m)
                .frame(minHeight: Space.target)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(changes.files.isEmpty)
            .accessibilityLabel("Changes, \(changes.summary)")
            if open {
                ForEach(changes.files) { f in
                    Hairline()
                    Button { withAnimation(.easeOut(duration: 0.18)) { file = file == f.file ? nil : f.file } } label: {
                        HStack(spacing: Space.m) {
                            Text(f.file).vyre(.commandRow).foregroundStyle(Color.text).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: Space.s)
                            Text("+\(f.added) -\(f.removed)").font(VyreFonts.base(.commandRow).asFont(size: 13)).foregroundStyle(Color.text2)
                        }
                        .padding(.vertical, Space.s)
                        .padding(.leading, Space.m)
                        .frame(minHeight: Space.target)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(f.diff == nil)
                    if file == f.file, let diff = f.diff { DiffView(text: diff) }
                }
            }
            Hairline()
        }
    }
}

/// A unified diff, one line each: added on `--signal-wash`, removed on `--del-wash` in `--text-2`.
struct DiffView: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).prefix(400).enumerated()), id: \.offset) { _, l in
                let line = String(l)
                let add = line.hasPrefix("+") && !line.hasPrefix("+++")
                let del = line.hasPrefix("-") && !line.hasPrefix("---")
                Text(line.isEmpty ? " " : line).vyre(.codeSmall)
                    .foregroundStyle(del ? Color.text2 : Color.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.s)
                    .background(add ? Color.signalWash : del ? Color.delWash : Color.clear)
            }
        }
        .padding(.vertical, Space.xs)
        .background(Color.blockBg, in: RoundedRectangle(cornerRadius: 6))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.bottom, Space.s)
    }
}

// MARK: draft

/// A draft held at the Gate: To, Subject and Body edit in place (tap into them; there is no Edit
/// button), the sources it drew from, and only Send and Discard. An edit makes the primary "Send
/// edited", which sends through gate.revise then gate.approve.
struct DraftDetail: View {
    @Environment(AppModel.self) private var app
    let item: NeedItem
    let gone: Bool
    @State private var draft: HeldDraft
    @State private var busy = false
    @State private var problem: String?

    init(item: NeedItem, draft: HeldDraft, gone: Bool) {
        self.item = item
        self.gone = gone
        _draft = State(initialValue: draft)
    }

    var body: some View {
        SheetFrame {
            SheetHead(item: item, gone: gone)
            VStack(alignment: .leading, spacing: 0) {
                Hairline()
                ForEach($draft.fields) { $f in SheetField(field: $f) }
            }
            .padding(.top, Space.l)
            if !draft.sources.isEmpty {
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(spacing: 6) {
                        Image(systemName: "clock.arrow.circlepath").font(.system(size: 14))
                        Text("From memory").vyre(.small, weight: 600)
                    }
                    .foregroundStyle(Color.recall)
                    ForEach(draft.sources, id: \.self) { Text($0).vyre(.secondary).foregroundStyle(Color.text) }
                }
                .padding(.vertical, 12).padding(.horizontal, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.recallWash, in: RoundedRectangle(cornerRadius: Radius.card))
                .padding(.top, Space.l)
            }
            if let changes = draft.changes {
                ChangesRowsHolder(changes: changes).padding(.top, Space.l)
            }
        } actions: {
            if let err = draft.error { FailedLine(text: "Held again: \(err)") }
            if let problem { FailedLine(text: problem) }
            Button { Task { await send() } } label: { PrimaryLabel(text: draft.sendLabel, faceID: item.faceID) }
                .buttonStyle(.vyre(.primary, large: true))
                .disabled(busy || gone)
            Button("Discard") { discard() }
                .buttonStyle(.vyre(.secondary, fill: true, medium: true))
                .disabled(busy || gone)
        }
        .onChange(of: draft) { _, d in app.needs.update(d) }
    }

    private func send() async {
        busy = true
        defer { busy = false }
        problem = nil
        do {
            if let err = try await app.needs.approve(draft) {
                draft.error = err
                Haptics.warning()
            } else {
                app.detail = nil
            }
        } catch where isCancel(error) {
        } catch {
            problem = describe(error)
        }
    }

    /// Discard is not destructive: it leaves with 4 s of Undo, like the swipe.
    private func discard() {
        app.needs.dismiss(.held(draft))
        app.detail = nil
    }
}

/// Changes for a held push, with its own open state.
private struct ChangesRowsHolder: View {
    let changes: ChangeSet
    @State private var open = false
    @State private var file: String?
    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            ChangesRows(changes: changes, open: $open, file: $file)
        }
    }
}

/// One field of a draft, editable where it stands: a label and the value as a text field that
/// reads as text until tapped. The body is the words themselves, full width.
struct SheetField: View {
    @Binding var field: HeldField
    @FocusState private var focused: Bool

    var body: some View {
        let isBody = field.key == "body"
        let plain = field.key == "to" || field.key == "url" || field.isJSON
        VStack(alignment: .leading, spacing: Space.xs) {
            if isBody {
                HStack {
                    Text(field.label).vyre(.secondary).foregroundStyle(Color.label)
                    Spacer()
                    if field.changed { Text("edited").vyre(.small).foregroundStyle(Color.label) }
                }
                input(plain: plain, role: .body)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                    Text(field.label).vyre(.secondary).foregroundStyle(Color.label).frame(width: 72, alignment: .leading)
                    input(plain: plain, role: field.isJSON || field.key == "method" ? .code : .secondary)
                    if field.changed { Text("edited").vyre(.small).foregroundStyle(Color.label) }
                }
            }
        }
        .padding(.vertical, Space.m)
        .overlay(alignment: .bottom) { Hairline(strong: focused) }
    }

    private func input(plain: Bool, role: TypeRole) -> some View {
        TextField("", text: $field.value, prompt: Text("Empty").foregroundStyle(Color.label), axis: .vertical)
            .vyre(role)
            .foregroundStyle(Color.text)
            .textInputAutocapitalization(plain ? .never : .sentences)
            .autocorrectionDisabled(plain)
            .keyboardType(field.key == "to" ? .emailAddress : .default)
            .focused($focused)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(field.label)
            .accessibilityHint("Edit in place")
    }
}

// MARK: question

/// A question: each question in Lead type, its choices as full-width rows, and "Something else" to
/// type. Answer (enabled once every question has one) and Later. No Face ID unless the box asks.
struct QuestionDetail: View {
    @Environment(AppModel.self) private var app
    let item: NeedItem
    let ask: AskItem
    let gone: Bool
    @State private var picks: [QuestionPick] = []
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        SheetFrame {
            SheetHead(item: item, gone: gone)
            ForEach(Array(ask.questions.enumerated()), id: \.offset) { i, q in
                QuestionBlock(q: q, pick: binding(i)).padding(.top, Space.l)
            }
            if ask.questions.isEmpty {
                Text(ask.summary).vyre(.lead).foregroundStyle(Color.text).padding(.top, Space.l)
            }
        } actions: {
            if let problem { FailedLine(text: problem) }
            Button { Task { await answer() } } label: { PrimaryLabel(text: "Answer", faceID: item.faceID) }
                .buttonStyle(.vyre(.primary, large: true))
                .disabled(busy || gone || answers == nil)
            Button("Later") {
                app.needs.dismiss(item)
                app.detail = nil
            }
            .buttonStyle(.vyre(.secondary, fill: true, medium: true))
            .disabled(busy || gone)
        }
        .onAppear { if picks.count != ask.questions.count { picks = ask.questions.map { _ in QuestionPick() } } }
    }

    private var answers: [String: String]? { QuestionPick.answers(ask.questions, picks) }

    private func binding(_ i: Int) -> Binding<QuestionPick> {
        Binding(get: { i < picks.count ? picks[i] : QuestionPick() },
                set: { v in if i < picks.count { picks[i] = v } })
    }

    private func answer() async {
        guard let a = answers else { return }
        busy = true
        defer { busy = false }
        problem = nil
        do {
            try await app.needs.answer(ask, .answers(a))
            app.detail = nil
        } catch where isCancel(error) {
        } catch {
            problem = describe(error)
        }
    }
}

/// One question and its choices. A picked choice has `--signal-wash` and a `--focus` border.
/// Shared by the sheet and the question card in a chat.
struct QuestionBlock: View {
    let q: AskQuestion
    @Binding var pick: QuestionPick
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let h = q.header, !h.isEmpty, h != q.question { Text(h).vyre(.label).foregroundStyle(Color.label) }
            Text(q.question).vyre(.lead).foregroundStyle(Color.text).fixedSize(horizontal: false, vertical: true)
            if q.multi { Text("Pick any.").vyre(.small).foregroundStyle(Color.label) }
            ForEach(q.options, id: \.self) { o in
                let on = pick.chosen.contains(o.label)
                Button { pick.choose(o.label, multi: q.multi); Haptics.tap() } label: {
                    HStack(spacing: Space.m) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(o.label).vyre(.rowTitle).foregroundStyle(Color.text)
                            if let n = o.note, !n.isEmpty { Text(n).vyre(.small).foregroundStyle(Color.text2).lineLimit(compact ? 2 : 4) }
                        }
                        Spacer(minLength: Space.s)
                        if on { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.text) }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, Space.s)
                    .frame(minHeight: 52)
                    .background(on ? Color.signalWash : Color.clear, in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(on ? Color.focus : Color.ruleStrong, lineWidth: on ? 2 : 1) }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            TextField("", text: Binding(get: { pick.text }, set: { pick.type($0, multi: q.multi) }),
                      prompt: Text("Something else").foregroundStyle(Color.label), axis: .vertical)
                .vyre(.input)
                .foregroundStyle(Color.text)
                .padding(.horizontal, 14)
                .padding(.vertical, Space.m)
                .frame(minHeight: 52)
                .background(pick.other && !pick.text.isEmpty ? Color.signalWash : Color.clear, in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.card)
                        .strokeBorder(pick.other && !pick.text.isEmpty ? Color.focus : Color.ruleStrong, lineWidth: pick.other && !pick.text.isEmpty ? 2 : 1)
                }
        }
    }
}
