// OversightModel: what the oversight panel knows about the runs an agent is driving on the Mac or
// in Chrome. It folds chrome.* events (capsule-sight posts one plan per run with chrome.plan, for the
// Mac and Chrome alike, keyed by `run`, the thread or the agent) into plain state and turns the
// person's taps into the tools that carry them out. Nothing here polls, opens a window or asks for
// anything: no event, no run, no panel.
//
// Events:  chrome.plan {run, title, steps:[{id, text, state}]}   the whole plan, resent on any change
//          chrome.step {run, id, state}   state todo|current|done|failed|skipped
//          chrome.voice {run, text, final}   the person's words, as they speak
//          chrome.paused|resumed|stopped, and hands.paused|resumed|stopped {run}
// Tools (the person's own call, no prompt): chrome.pause|resume|stop {run}, chrome.plan.edit {run, step, text},
//          chrome.interject {from, text, run}; Chrome has one active run today, so a card for another run is refused
//          with not_found rather than acting on the active one; hands.pause|resume|stop
//          {run} once a hands.* event has named the run. chrome.finished {run, ok} ends a run; an all-over plan also closes it.

import Foundation

enum StepState: String, Equatable {
    case todo, current, done, skipped, failed
    /// Nothing more will happen to this step.
    var isOver: Bool { self == .done || self == .skipped || self == .failed }
}

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
    /// The run's pause, stop and resume go to hands.* once a hands.* event has named it, else to chrome.*.
    var viaHands = false

    /// The step the agent is on, else the first that is not done.
    var currentIndex: Int? {
        steps.firstIndex { $0.state == .current } ?? steps.firstIndex { $0.state == .todo }
    }
    var done: Int { steps.filter { $0.state.isOver }.count }
    var finished: Bool { !steps.isEmpty && steps.allSatisfy { $0.state.isOver } }
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
    // The plan and its steps come from chrome.plan and chrome.step for a run on the Mac or in Chrome
    // (capsule-sight: there is no separate hands.plan); pause, stop and resume go to the surface that
    // run's own events came from.
    var canPause: Bool { vyred.has("chrome.pause") && vyred.has("chrome.resume") || vyred.has("hands.pause") && vyred.has("hands.resume") }
    var canEdit: Bool { vyred.has("chrome.plan.edit") }
    var canSteer: Bool { vyred.has("chrome.interject") }

    // MARK: events

    func apply(_ e: VyredEvent) {
        let before = isActive
        let p = e.payload
        guard let run = VJ.nonEmpty(p["run"]) ?? e.thread.flatMap({ $0.isEmpty ? nil : $0 }) else { return }
        let fromHands = e.type.hasPrefix("hands.")
        switch e.type {
        case "chrome.plan":
            let steps = ((p["steps"] as? [[String: Any]]) ?? []).enumerated().compactMap { i, s -> OversightStep? in
                guard let text = VJ.nonEmpty(s["text"]) else { return nil }
                return OversightStep(id: VJ.nonEmpty(s["id"]) ?? "\(i + 1)", text: text,
                                     state: StepState(rawValue: (s["state"] as? String) ?? "") ?? .todo)
            }
            var r = OversightRun(id: run, title: VJ.nonEmpty(p["title"]) ?? "Working for you", steps: steps)
            if let old = runs.first(where: { $0.id == run }) { r.paused = old.paused; r.viaHands = old.viaHands; if p["steps"] == nil { return } }
            // A new plan answers whatever the person said.
            r.voice = nil
            put(r)
        case "chrome.step":
            guard var r = runs.first(where: { $0.id == run }), let id = VJ.nonEmpty(p["id"]) ?? VJ.nonEmpty(p["step"]),
                  let st = StepState(rawValue: (p["state"] as? String) ?? ""),
                  let i = r.steps.firstIndex(where: { $0.id == id }) else { return }
            r.steps[i].state = st
            put(r)
        case "chrome.voice":
            guard var r = runs.first(where: { $0.id == run }) else { return }
            // A finished sentence stays until the plan answers it; empty text clears it.
            r.voice = VJ.nonEmpty(p["text"])
            put(r, front: false)
        case "chrome.stopped", "hands.stopped":
            drop(run)
        case "chrome.finished":
            // The run is over (chrome.plan {finish}, or a stop). A good finish lingers a moment like an all-done
            // plan; a bad one goes at once.
            guard runs.contains(where: { $0.id == run }) else { return }
            if (p["ok"] as? Bool) == false { drop(run) } else { lingerThenDrop(run) }
        case "chrome.paused", "hands.paused":
            guard var r = runs.first(where: { $0.id == run }) else { return }
            r.paused = true
            if fromHands { r.viaHands = true }
            put(r, front: false)
        case "chrome.resumed", "hands.resumed":
            guard var r = runs.first(where: { $0.id == run }) else { return }
            r.paused = false
            if fromHands { r.viaHands = true }
            put(r, front: false)
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

    private func lingerThenDrop(_ id: String) {
        lingering[id]?.cancel()
        lingering[id] = Task { @MainActor [weak self, linger] in
            try? await Task.sleep(for: linger)
            guard !Task.isCancelled, let self else { return }
            let before = self.isActive
            self.drop(id)
            if before != self.isActive { self.onPresence?() }
        }
    }

    private func drop(_ run: String) {
        lingering[run]?.cancel(); lingering[run] = nil
        runs.removeAll { $0.id == run }
        if runs.isEmpty { collapsed = false; editing = nil; line = nil }
    }

    // MARK: the person's taps

    func pause() {
        guard let r = active else { return }
        let surface = r.viaHands && vyred.has("hands.pause") ? "hands" : "chrome"
        call("\(surface).\(r.paused ? "resume" : "pause")", ["run": r.id])
    }
    func stop() {
        guard let r = active else { return }
        call(r.viaHands && vyred.has("hands.stop") ? "hands.stop" : "chrome.stop", ["run": r.id])
    }

    /// Retext a step that has not started. An empty or unchanged text changes nothing.
    func edit(step: String, to text: String) {
        editing = nil
        guard let r = active, let s = r.steps.first(where: { $0.id == step }), s.editable else { return }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty || t == s.text { return }
        call("chrome.plan.edit", ["run": r.id, "step": step, "text": t])
    }

    /// A course correction, typed or spoken. The agent answers by resending its plan.
    func steer(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = active, !t.isEmpty else { return }
        call("chrome.interject", ["from": "prompt", "text": t, "run": r.id])
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
}
