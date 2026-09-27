import SwiftUI

/// Pieces every screen shares: the page head, list rows, the search field and error wording.

/// A thrown error as the one line a screen shows.
func describe(_ error: Error) -> String {
    if let e = error as? VyreError {
        if e.isMissingFeature { return "The box does not have this yet. \(e.message)" }
        if case .denied = e { return "The box refuses this from a phone. \(e.message)" }
        return e.message
    }
    return (error as? LocalizedError)?.errorDescription ?? "\(error)"
}

/// True for a cancelled Face ID sheet or a cancelled task: say nothing.
func isCancel(_ error: Error) -> Bool {
    (error as? VyreError) == .cancelled || error is CancellationError
}

/// The head of a tab: an engraved eyebrow, a title and an optional sentence below.
struct PageHead: View {
    var eyebrow: String?
    let title: String
    var sub: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let eyebrow { Engraved(eyebrow) }
            Text(title).vyre(.h1).foregroundStyle(Color.text).fixedSize(horizontal: false, vertical: true)
            if let sub, !sub.isEmpty { Text(sub).vyre(.body).foregroundStyle(Color.text2).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Space.m)
    }
}

/// A plain row: a dot, a title, a line below, a mono note on the right, a hairline under it.
struct ListRow: View {
    let title: String
    var detail: String? = nil
    var note: String? = nil
    var dot: Color? = nil
    var mono = false
    var chevron = true

    var body: some View {
        HStack(alignment: .center, spacing: Space.m) {
            if let dot { Dot(color: dot) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).vyre(mono ? .code : .title).foregroundStyle(Color.text).lineLimit(2)
                if let detail, !detail.isEmpty { Text(detail).vyre(.small).foregroundStyle(Color.text2).lineLimit(2) }
            }
            Spacer(minLength: Space.s)
            if let note, !note.isEmpty { Text(note).vyre(.codeSmall).foregroundStyle(Color.label).lineLimit(1) }
            if chevron { Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(Color.label) }
        }
        .padding(.vertical, Space.m)
        .frame(minHeight: Space.target)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// The one-line search field used by Capsule, Files and Memory.
struct SearchField: View {
    @Binding var text: String
    let prompt: String
    var icon = "magnifyingglass"
    var submit: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Space.s) {
            Image(systemName: icon).font(.system(size: 15, weight: .medium)).foregroundStyle(Color.label)
            TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Color.label))
                .vyre(.body)
                .foregroundStyle(Color.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(submit)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.label) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, Space.m)
        .frame(minHeight: Space.target)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.button)
                .strokeBorder(focused ? Color.focus : Color.ruleStrong, lineWidth: focused ? 2 : 1)
        }
    }
}

/// A thread's status as a dot colour: Beacon waiting on the person, Signal working, ash otherwise.
func statusDot(_ status: String?, asks: Int = 0) -> Color {
    if asks > 0 || status == "waiting" { return .beaconInk }
    switch status {
    case "working", "starting": return .focus
    default: return .label
    }
}

/// "3 things", "1 thing".
func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

/// Today's date as the Now head writes it: "SATURDAY 27 SEPTEMBER".
func todayLabel(_ d: Date = Date()) -> String {
    let f = DateFormatter()
    f.locale = Locale.current
    f.setLocalizedDateFormatFromTemplate("EEEE d MMMM")
    return f.string(from: d)
}

/// Loading, failed or empty: one of the three states a list screen shows before rows.
struct LoadState: View {
    let loading: Bool
    let problem: String?
    let empty: String?

    var body: some View {
        if let problem { FailedLine(text: problem).padding(.vertical, Space.m) }
        else if loading { HStack(spacing: Space.s) { ProgressView().tint(Color.label); Engraved("Loading") }.padding(.vertical, Space.m) }
        else if let empty { EmptyLine(text: empty) }
    }
}

/// Byte counts as the file rows write them.
func byteSize(_ n: Double?) -> String {
    guard let n else { return "" }
    return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
}

/// "AB" from "Alex Brandt", "A" from "alex"; the host's first letter when there is no name.
func initials(name: String?, host: String) -> String {
    let words = (name ?? "").split(whereSeparator: { $0.isWhitespace }).prefix(2)
    let s = words.compactMap(\.first).map(String.init).joined()
    return (s.isEmpty ? String(host.first ?? "v") : s).uppercased()
}

/// A model's name without its maker's: "sonnet-4-5" for "claude-sonnet-4-5". The phone names
/// the assistant and the agents, never the model's maker (a user rule).
func modelLabel(_ m: String?) -> String? {
    guard var m, !m.isEmpty else { return nil }
    for p in ["claude-", "claude_", "claude"] where m.lowercased().hasPrefix(p) { m = String(m.dropFirst(p.count)); break }
    return m.isEmpty ? nil : m
}

/// An agent's tile: its initial on `--hover`, `--rule-strong` border (32 px at radius 8; 22 and 40
/// elsewhere).
struct Tile: View {
    let name: String
    var size: CGFloat = 32
    var body: some View {
        Text(String(name.first ?? "v").uppercased())
            .font(VyreFonts.base(.rowTitle).asFont(size: size * 15 / 32))
            .foregroundStyle(Color.text)
            .frame(width: size, height: size)
            .background(Color.hover, in: RoundedRectangle(cornerRadius: size >= 40 ? 11 : Radius.tile))
            .overlay { RoundedRectangle(cornerRadius: size >= 40 ? 11 : Radius.tile).strokeBorder(Color.ruleStrong, lineWidth: 1) }
            .accessibilityHidden(true)
    }
}

/// A card: `--panel`, `--rule` border, radius 10. Rows inside draw their own hairlines.
struct Card<Content: View>: View {
    var fill: Color = .panel
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.rule, lineWidth: 1) }
            .clipShape(RoundedRectangle(cornerRadius: Radius.card))
    }
}

/// A filter chip (Chats' projects): 30 tall, radius 8, 13/600; selected is `--text` on `--bg` text.
struct FilterChip: View {
    let label: String
    let on: Bool
    let tap: () -> Void
    var body: some View {
        Button(action: tap) {
            Text(label).vyre(.small, weight: 600)
                .foregroundStyle(on ? Color.bg : Color.text2)
                .padding(.horizontal, Space.m)
                .frame(height: 30)
                .background(on ? Color.text : Color.clear, in: RoundedRectangle(cornerRadius: Radius.tile))
                .overlay { if !on { RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Color.ruleStrong, lineWidth: 1) } }
                .frame(minHeight: Space.target)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A section header on Now: sentence case in Section type, the count on the right.
struct SectionHeader: View {
    let title: String
    var count: Int?
    var dot: Color?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            if let dot { Dot(color: dot, size: 8).alignmentGuide(.firstTextBaseline) { d in d[.bottom] + 2 } }
            Text(title).vyre(.section).foregroundStyle(Color.text).accessibilityAddTraits(.isHeader)
            Spacer()
            if let count { Text("\(count)").vyre(.secondary).foregroundStyle(Color.label) }
        }
        .padding(.top, Space.l)
        .padding(.bottom, Space.s)
    }
}

/// A left-to-right layout that wraps: an agent's project chips.
struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}
