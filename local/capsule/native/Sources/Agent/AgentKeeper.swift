// Keeper: the threads the Capsule holds, and what it lets go of when it hides.
//
// A quick question runs Claude Code in a thread of its own (threads.start, lean). Left alone, that
// process idles after its answer, and the keyboard of any thread the Capsule typed into stays
// with the Capsule. So when the Capsule hides: the lease goes back (threads.release), and every
// quick thread is stopped (threads.stop {thread}); one still answering is stopped when its turn
// ends. A follow-up later resumes the thread from its transcript. Mirrors the Electron bridge's
// releaseLease and reap.

import Foundation

@MainActor
final class Keeper {
    let vyred: VyredClient
    /// Quick threads this Capsule started, whatever their state.
    private(set) var quick: Set<String> = []
    /// Quick threads with a process that may still be running.
    private(set) var running: Set<String> = []
    /// The thread whose keyboard this Capsule holds.
    private(set) var lease: String?
    /// Hidden: a quick thread still answering is stopped once its turn ends.
    private(set) var reaping = false

    init(vyred: VyredClient) { self.vyred = vyred }

    /// A quick question's thread started: the Capsule holds its keyboard, and its process runs.
    func startedQuick(_ id: String) { quick.insert(id); running.insert(id); lease = id }

    /// Words typed into a thread (a follow-up, @thread, a new thread in a project).
    func typed(into id: String) {
        lease = id
        if quick.contains(id) { running.insert(id) }
    }

    func shown() { reaping = false }

    /// The Capsule hid. `busy` is a thread still answering on screen: it finishes its turn first.
    func hidden(busy: String?) {
        reaping = true
        if let t = lease {
            lease = nil
            if vyred.has("threads.release") { Task { [vyred] in _ = await vyred.call("threads.release", ["thread": t, "surface": "capsule"], presence: false) } }
        }
        for t in running where t != busy { stop(t) }
    }

    /// An event of a thread the Capsule follows: a quick thread that finished while hidden stops.
    func heard(_ e: VyredEvent) {
        guard let t = e.thread else { return }
        if e.type == "thread.stopped" { running.remove(t); return }
        if e.type == "thread.finished", reaping, running.contains(t) { stop(t) }
    }

    /// threads.stop takes {thread}. Its transcript stays; the next send resumes it.
    func stop(_ t: String) {
        running.remove(t)
        guard vyred.has("threads.stop") else { return }
        Task { [vyred] in _ = await vyred.call("threads.stop", ["thread": t], presence: false) }
    }
}
