// FirstRunWindow: "Where should Vyre run?" for a Mac that has no vyred and no server. The Capsule is an accessory app (no Dock icon, no window of its own), so
// this window takes the same road VyreAppWindow does: it makes the app a regular one while it is open, which gives it a Dock icon, and puts it back to an
// accessory app when it closes (the app window, which follows, makes it regular again).
//
// On this Mac: the app's own setup runs (StartVyre.swift, BundledSetup: the installer with the Mac password asked once in a dialog), its lines are shown as
// they come, a failure is shown in plain words with a way to try again or go back, and when vyred answers the app window opens.
// On a server: the app window opens with no local vyred (VyreAppWindow.show(boxless: true)); its page pairs to the server by typed code over the relay.
// The choice is kept (FirstRunStore), so every launch after this one opens straight into the app (FirstRun.decide).

import AppKit
import Combine
import SwiftUI

/// What the window is showing.
enum FirstRunPhase: Equatable {
    case choose
    /// "Run this on your server": the line to paste there, then the app window pairs by the code the server shows.
    case serverLine
    case settingUp
    case failed(FirstRunWords.Failure)
}

@MainActor
final class FirstRunController: ObservableObject {
    @Published private(set) var phase: FirstRunPhase = .choose
    let model: CapsuleModel
    let store: FirstRunStore
    private var window: NSWindow?
    private var watch: AnyCancellable?
    private var decided = false

    init(model: CapsuleModel, home: String) {
        self.model = model
        self.store = FirstRunStore(home: home)
    }

    /// The first look at vyred said `up`: do what the kept choice, or the lack of one, says. Later changes only matter while setting up.
    func vyredChanged(up: Bool) {
        if !decided {
            decided = true
            switch FirstRun.decide(vyredUp: up, remembered: store.load()) {
            case .nothing: return
            case .askWhere: show()
            case .startHere: show(); setUpHere(remember: false)
            case .openApp(let boxless): openApp(boxless: boxless)
            }
            return
        }
        if up, phase == .settingUp { openApp(boxless: false) }
    }

    func show() {
        phase = .choose
        if window == nil { build() }
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 460), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        w.title = "Vyre"
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: FirstRunView(controller: self, model: model))
        w.center()
        window = w
        watch = NotificationCenter.default.publisher(for: NSWindow.willCloseNotification, object: w).sink { [weak self] _ in
            MainActor.assumeIsolated { self?.closed() }
        }
    }

    /// The person closed the window (or it was closed for the app). Not setting up any more; the Dock icon goes unless the app window took over.
    private func closed() {
        window = nil; watch = nil
        if !VyreAppWindow.shared.isOpen { NSApp.setActivationPolicy(.accessory) }
    }

    // MARK: The two choices

    func chooseHere() { setUpHere(remember: true) }

    private func setUpHere(remember: Bool) {
        if remember { store.save(.here) }
        phase = .settingUp
        model.startVyre()
    }

    /// On a server: first the line to run there.
    func chooseServer() { phase = .serverLine }

    /// The server shows a code: open the app with no vyred of its own, and keep the choice.
    func serverShowsCode() {
        store.save(.server)
        openApp(boxless: true)
    }

    /// Stop a setup in progress and go back to the question.
    func cancelSetUp() {
        model.commandRun?.stop()
        back()
    }

    /// Back to the question from a failure. Nothing is kept until a choice works.
    func back() {
        store.forget()
        phase = .choose
    }

    /// Say what went wrong in plain words, when the setup has finished badly.
    func checkRun(_ run: CommandRun?) {
        guard phase == .settingUp, let run, !run.running else { return }
        if let said = FirstRunView.failure(of: run) { phase = .failed(FirstRunWords.failure(said)) }
    }

    private func openApp(boxless: Bool) {
        window?.close()
        VyreAppWindow.shared.show(boxless: boxless)
    }
}

struct FirstRunView: View {
    @ObservedObject var controller: FirstRunController
    @ObservedObject var model: CapsuleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            switch controller.phase {
            case .choose: choose
            case .serverLine: serverLine
            case .settingUp: settingUp
            case .failed(let why): failed(why)
            }
            Spacer(minLength: 0)
        }
        .padding(32)
        .frame(width: 520, height: 460, alignment: .topLeading)
    }

    private var choose: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(FirstRunWords.title).font(.system(size: 26, weight: .semibold))
            Text(FirstRunWords.line).foregroundStyle(.secondary)
            choice(FirstRunWords.hereTitle, FirstRunWords.hereLine, id: "first-run-here") { controller.chooseHere() }
            choice(FirstRunWords.serverTitle, FirstRunWords.serverLine, id: "first-run-server") { controller.chooseServer() }
        }
    }

    private func choice(_ title: String, _ line: String, id: String, _ go: @escaping () -> Void) -> some View {
        Button(action: go) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold))
                Text(line).font(.system(size: 13)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.35)))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private var serverLine: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(FirstRunWords.serverStepTitle).font(.system(size: 22, weight: .semibold))
            Text(FirstRunWords.serverStepLine).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(FirstRunWords.installLine(version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String))
                .font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.12)))
            Button(FirstRunWords.copyLine) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(FirstRunWords.installLine(version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String), forType: .string)
            }
            HStack {
                Button(FirstRunWords.serverShowsCode) { controller.serverShowsCode() }.keyboardShortcut(.defaultAction)
                Button("Back") { controller.back() }
            }
        }
    }

    private var settingUp: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(FirstRunWords.settingTitle).font(.system(size: 22, weight: .semibold))
            Text(FirstRunWords.settingLine).foregroundStyle(.secondary)
            ProgressView().progressViewStyle(.linear)
            if let run = model.commandRun { RunSteps(run: run, controller: controller) }
            Text(FirstRunWords.passwordNote).font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Cancel") { controller.cancelSetUp() }
        }
    }

    private func failed(_ why: FirstRunWords.Failure) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(why.title).font(.system(size: 22, weight: .semibold))
            Text(why.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Try again") { controller.chooseHere() }.keyboardShortcut(.defaultAction)
                Button("Choose a server instead") { controller.chooseServer() }
            }
        }
    }

    /// What a setup that ended badly said last (the words come from FirstRunWords.failure), or nil when it did not end badly (an exit of 0 waits for vyred to answer).
    @MainActor static func failure(of run: CommandRun) -> String? {
        if let f = run.failure, !f.isEmpty { return f }
        guard let code = run.exit, code != 0 else { return nil }
        for v in run.views.reversed() { if case .error(_, let message, _) = v { return message } }
        for v in run.views.reversed() { if case .text(let lines) = v, let last = lines.last(where: { !$0.isEmpty }) { return last } }
        return ""
    }
}

/// The three steps of "Setting up Vyre on this Mac": done, current, waiting, by what the setup has said so far. Tells the controller when the run has ended.
struct RunSteps: View {
    @ObservedObject var run: CommandRun
    let controller: FirstRunController

    var body: some View {
        // The installer's lines are not step names: it has said something once it has begun (Getting Vyre is done), and the space is the last thing it does.
        let said = run.views.contains { if case .text(let l) = $0 { return !l.isEmpty } else { return false } }
        let marks = said ? ["checkmark.circle.fill", "circle.dotted", "circle"] : ["circle.dotted", "circle", "circle"]
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(FirstRunWords.settingSteps.enumerated()), id: \.offset) { i, name in
                Label(name, systemImage: marks[i]).font(.system(size: 14))
            }
        }
        .onChange(of: run.running) { _ in controller.checkRun(run) }
    }
}
