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
            Text(title).vyre(.h1).foregroundStyle(Color.bone).fixedSize(horizontal: false, vertical: true)
            if let sub, !sub.isEmpty { Text(sub).vyre(.body).foregroundStyle(Color.stone).fixedSize(horizontal: false, vertical: true) }
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
                Text(title).vyre(mono ? .code : .title).foregroundStyle(Color.bone).lineLimit(2)
                if let detail, !detail.isEmpty { Text(detail).vyre(.small).foregroundStyle(Color.stone).lineLimit(2) }
            }
            Spacer(minLength: Space.s)
            if let note, !note.isEmpty { Text(note).vyre(.codeSmall).foregroundStyle(Color.ash).lineLimit(1) }
            if chevron { Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(Color.ash) }
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
            Image(systemName: icon).font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ash)
            TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Color.ash))
                .vyre(.body)
                .foregroundStyle(Color.bone)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(submit)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.ash) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, Space.m)
        .frame(minHeight: Space.target)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.button)
                .strokeBorder(focused ? Color.signal : Color.ruleStrong, lineWidth: focused ? 2 : 1)
        }
    }
}

/// A thread's status as a dot colour: Beacon waiting on the person, Signal working, ash otherwise.
func statusDot(_ status: String?, asks: Int = 0) -> Color {
    if asks > 0 || status == "waiting" { return .beacon }
    switch status {
    case "working", "starting": return .signal
    default: return .ash
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
        else if loading { HStack(spacing: Space.s) { ProgressView().tint(Color.ash); Engraved("Loading") }.padding(.vertical, Space.m) }
        else if let empty { EmptyLine(text: empty) }
    }
}

/// Byte counts as the file rows write them.
func byteSize(_ n: Double?) -> String {
    guard let n else { return "" }
    return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
}
