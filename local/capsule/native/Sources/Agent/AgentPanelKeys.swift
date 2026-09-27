// The keys of the waiting list and its cards, taken before the Capsule's own (Host/Panel.swift).
//
//   ↑ in an empty box            opens the list, when anything waits (↓ too, and ⏎ the oldest's
//                                card, while the compact panel shows it)
//   ⌘C in an empty box            copies the answer on screen
//   ⌘K                            the highlighted row's verbs, to pick one (↑↓ ⏎, Esc back)
//   Tab                           sends the words to the first destination, whatever is highlighted
//   list: ↑↓ move, ⏎ open, A allow (yes to the row), D deny (an ask only), Esc closes the list;
//         ↑ on the first row goes back
//   card: ⌘⏎ yes (Send, Allow, Accept); ⏎ yes for an ask or a lesson, which have no fields;
//         Esc goes back to the list
// There are no single-letter keys on a card: every line of a draft takes typing.

import AppKit

extension PanelController {
    func agentKey(_ e: NSEvent) -> Bool {
        let desk = model.desk
        let f = e.modifierFlags.intersection([.command, .option, .control, .shift])
        // ⌘K lists the highlighted row's verbs; in the list, ↑↓ ⏎ and Esc.
        let menu = model.actionMenu
        if menu.isOpen {
            switch e.keyCode {
            case 125: menu.move(1); return true
            case 126: menu.move(-1); return true
            case 36, 76: let i = menu.index; menu.close(); model.run(actionAt: i); return true
            case 53: menu.close(); return true
            default: menu.close(); return false
            }
        }
        if f == .command, e.charactersIgnoringModifiers?.lowercased() == "k", desk.mode == .none, let r = model.current, r.actions.count > 1 {
            menu.open(r); return true
        }
        switch desk.mode {
        case .none:
            if e.keyCode == 126, f.isEmpty, model.text.isEmpty, model.target == nil, model.asked == nil, !desk.waiting.isEmpty {
                desk.openList(); return true
            }
            // The compact panel shows what waits: ↓ goes into the list too, ⏎ opens the oldest.
            if f.isEmpty, AgentLayout.hintShown(model), !CapsuleLayout.isOpen(model), let first = desk.waiting.first {
                if e.keyCode == 125 { desk.openList(); return true }
                if e.keyCode == 36 || e.keyCode == 76 { desk.openCard(first); return true }
            }
            // ⌘C under an answer, with nothing typed, copies the answer.
            if e.keyCode == 8, f == .command, model.text.isEmpty, model.copyReply() { return true }
            // Tab sends the words on, to the first destination, whatever row is highlighted.
            if e.keyCode == 48, f.isEmpty, !model.text.isEmpty, model.current?.kind != "mention",
               let i = model.flat.firstIndex(where: { $0.kind == "ask" }) {
                model.selected = i; model.run(); return true
            }
            return false
        case .list:
            switch e.keyCode {
            case 125: desk.move(1); return true
            case 126: desk.move(-1); return true
            case 36, 76: if let w = desk.highlighted { desk.openCard(w) }; return true
            case 53: desk.mode = .none; return true
            default:
                if f.isEmpty, e.charactersIgnoringModifiers?.lowercased() == "a", let w = desk.highlighted { Task { await desk.yes(w) }; return true }
                // D denies a focused ask where it is; a held send or a lesson needs its card to say no.
                if f.isEmpty, e.charactersIgnoringModifiers?.lowercased() == "d", let w = desk.highlighted, w.source == .ask { Task { await desk.no(w) }; return true }
                // Typing anything else goes back to the box, with the keystroke.
                desk.mode = .none; return false
            }
        case .card:
            guard let w = desk.open else { desk.mode = .none; return false }
            switch e.keyCode {
            case 53: desk.back(); focus.count += 1; return true
            case 36, 76:
                if f == .command { Task { await desk.yes(w) }; return true }
                if f.isEmpty, w.source != .gate { Task { await desk.yes(w) }; return true }
                return false
            default: return false
            }
        }
    }
}

extension CapsuleModel {
    /// Clicking away does not close the Capsule while a reply streams or a card is open.
    /// A message queued for a busy session can wait minutes, so it does not pin.
    var pinned: Bool { desk.pinned || (reply.map { !$0.finished && $0.queued == nil } ?? false) }
}
