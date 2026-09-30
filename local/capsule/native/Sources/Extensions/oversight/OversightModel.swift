// OversightModel: what the oversight panel knows about the runs an agent is driving on the Mac or
// in Chrome. It folds hands.* events (capsule-sight's contract, keyed by `run`, the thread or job
// id) into plain state and turns the person's taps into the tools that carry them out. Nothing
// here polls, opens a window or asks for anything: no event, no run, no panel.
//
// Events:  hands.plan {run, title, steps:[{id, text, state}]}   the whole plan, resent on any change
//          hands.step {run, step, state}                         one step moves
//          hands.voice {run, text, final}                        the person's words, as they speak
//          hands.paused|resumed|stopped {run}
// Tools (the person's own call, no prompt): hands.pause, hands.resume, hands.stop,
//          hands.plan.edit {run, step, text}, hands.steer {run, text}.

import Foundation

enum StepState: String, Equatable { case todo, current, done, skipped }

struct OversightStep: Equatable, Identifiable {
    var id: String
    var text: String
    var state: StepState

    /// Only a step that has not started can be retexted; the running one is steered instead.
    var editable: Bool { state == .todo }
}

struct OversightRun: Equatable, Identifiable {
    var id: String
    var title: String
    var steps: [OversightStep]
    /// What the person is saying to the agent right now, until the plan answers it.
    var voice: String?
    var paused = false

    /// The step the agent is on, else the first that is not done.
    var currentIndex: Int? {
        steps.firstIndex { $0.state == .current } ?? steps.firstIndex { $0.state == .todo }
    }
    var done: Int { steps.filter { $0.state == .done || $0.state == .skipped }.count }
    var finished: Bool { !steps.isEmpty && steps.allSatisfy { $0.state == .done || $0.state == .skipped } }
}

@MainActor
final class OversightModel: ObservableObject {
    /// Most recently changed first.
    @Published private(set) var runs: [OversightRun] = []
    @Published var collapsed = false { didSet { if collapsed != oldValue { onPresence?() } } }
    /// One line under the controls, for a refused call ("That step already started.").
    @Published var line: String? { didSet { if (line == nil) != (oldValue == nil) { onPresence?() } } }
    /// The run a step is being retexted in, and the step.
    @Published var editing: String?

    private let vyred: VyredLink
    /// How long a finished plan stays up before the panel lets go of it. Tests shorten it.
    var linger: Duration = .seconds(4)
    private var lingering: [String: Task<Void, Never>] = [:]
    /// Called when the window must be opened, closed or resized: the runs went empty or non-empty,
    /// the panel was made small, or a line appeared under it.
    var onPresence: (() -> Void)?

    init(vyred: VyredLink) { self.vyred = vyred }

    var active: OversightRun? { runs.first }
    var isActive: Bool { !runs.isEmpty }

    // Which of the panel's controls this vyred can honour; the rest are not drawn.
    var canPause: Bool { vyred.has("hands.pause") && vyred.has("hands.resume") }
    var canEdit: Bool { vyred.has("hands.plan.edit") }
    var canSteer: Bool { vyred.has("hands.steer") }

    // MARK: events

    func apply(_ e: VyredEvent) {
        let before = isActive
        let p = e.payload
        guard let run = VJ.nonEmpty(p["run"]) ?? e.thread.flatMap({ $0.isEmpty ? nil : $0 }) else { return }
        switch e.type {
        case "hands.plan":
            let steps = ((p["steps"] as? [[String: Any]]) ?? []).enumerated().compactMap { i, s -> OversightStep? in
                guard let text = VJ.nonEmpty(s["text"]) else { return nil }
                return OversightStep(id: VJ.nonEmpty(s["id"]) ?? "\(i + 1)", text: text,
                                     state: StepState(rawValue: (s["state"] as? String) ?? "") ?? .todo)
            }
            var r = OversightRun(id: run, title: VJ.nonEmpty(p["title"]) ?? "Working on your Mac", steps: steps)
            if let old = runs.first(where: { $0.id == run }) { r.paused = old.paused }
            // A new plan answers whatever the person said.
            r.voice = nil
            put(r)
        case "hands.step":
            guard var r = runs.first(where: { $0.id == run }), let id = VJ.nonEmpty(p["step"]),
                  let st = StepState(rawValue: (p["state"] as? String) ?? ""),
                  let i = r.steps.firstIndex(where: { $0.id == id }) else { return }
            r.steps[i].state = st
            put(r)
        case "hands.voice":
            guard var r = runs.first(where: { $0.id == run }) else { return }
            let text = VJ.nonEmpty(p["text"])
            // A finished sentence stays until the plan answers it; empty text clears it.
            r.voice = text
            put(r, front: false)
        case "hands.paused", "hands.resumed":
            guard var r = runs.first(where: { $0.id == run }) else { return }
            r.paused = e.type == "hands.paused"
            put(r, front: false)
        case "hands.stopped":
            drop(run)
        default: return
        }
        if before != isActive { onPresence?() }
    }

    private func put(_ r: OversightRun, front: Bool = true) {
        if let i = runs.firstIndex(where: { $0.id == r.id }) {
            runs.remove(at: i)
            runs.insert(r, at: front ? 0 : min(i, runs.count))
        } else {
            runs.insert(r, at: 0)
        }
        lingering[r.id]?.cancel(); lingering[r.id] = nil
        if r.finished {
            let id = r.id
            lingering[id] = Task { @MainActor [weak self, linger] in
                try? await Task.sleep(for: linger)
                guard !Task.isCancelled, let self else { return }
                let before = self.isActive
                self.drop(id)
                if before != self.isActive { self.onPresence?() }
            }
        }
    }

    private func drop(_ run: String) {
        lingering[run]?.cancel(); lingering[run] = nil
        runs.removeAll { $0.id == run }
        if runs.isEmpty { collapsed = false; editing = nil; line = nil }
    }

    // MARK: the person's taps

    func pause() { call(active.map { $0.paused ? "hands.resume" : "hands.pause" } ?? "", ["run": active?.id ?? ""]) }
    func stop() {
        guard let r = active else { return }
        call("hands.stop", ["run": r.id])
    }

    /// Retext a step that has not started. An empty or unchanged text changes nothing.
    func edit(step: String, to text: String) {
        editing = nil
        guard let r = active, let s = r.steps.first(where: { $0.id == step }), s.editable else { return }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty || t == s.text { return }
        call("hands.plan.edit", ["run": r.id, "step": step, "text": t])
    }

    /// A course correction, typed or spoken. The agent answers by resending its plan.
    func steer(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = active, !t.isEmpty else { return }
        call("hands.steer", ["run": r.id, "text": t])
    }

    private func call(_ tool: String, _ input: [String: Any]) {
        guard !tool.isEmpty else { return }
        line = nil
        Task { [vyred, weak self] in
            let r = await vyred.call(tool, input, presence: false)
            await MainActor.run {
                guard let self, let why = r.error else { return }
                self.line = why
            }
        }
    }
}

/// How big the panel is, so the window can be sized without measuring the view.
enum OversightLayout {
    static let width: CGFloat = 320
    static let maxSteps = 6
    static let charsPerLine = 34
    static let header: CGFloat = 40
    static let compactHeight: CGFloat = 34
    static let voice: CGFloat = 36
    static let prompt: CGFloat = 44
    static let controls: CGFloat = 44
    static let line: CGFloat = 22
    static let more: CGFloat = 20

    static func lines(_ text: String) -> Int { min(2, max(1, (text.count + charsPerLine - 1) / charsPerLine)) }
    static func rowHeight(_ s: OversightStep) -> CGFloat { 12 + CGFloat(lines(s.text)) * 16 }

    /// The steps shown: a window of at most maxSteps around the current one, oldest done first cut.
    static func visible(_ r: OversightRun) -> (steps: [OversightStep], before: Int, after: Int) {
        let n = r.steps.count
        if n <= maxSteps { return (r.steps, 0, 0) }
        let cur = r.currentIndex ?? 0
        var start = max(0, cur - 2)
        start = min(start, n - maxSteps)
        let end = start + maxSteps
        return (Array(r.steps[start..<end]), start, n - end)
    }

    static func height(_ r: OversightRun, collapsed: Bool, canSteer: Bool, hasLine: Bool) -> CGFloat {
        if collapsed { return compactHeight }
        let v = visible(r)
        var h = header + v.steps.reduce(0) { $0 + rowHeight($1) } + 12
        if v.before > 0 { h += more }
        if v.after > 0 { h += more }
        if r.voice != nil { h += voice }
        if canSteer { h += prompt }
        h += controls
        if hasLine { h += line }
        return h
    }
}
