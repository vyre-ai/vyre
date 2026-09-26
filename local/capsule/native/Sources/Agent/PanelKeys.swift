// The keys of the waiting list and its cards, taken before the Capsule's own (Host/Panel.swift).
//
//   ↑ in an empty box            opens the list, when anything waits
//   list: ↑↓ move, ⏎ open, A allow (yes to the row), Esc closes the list; ↑ on the first row goes back
//   card: ⌘⏎ yes (Send, Allow, Accept); ⏎ yes for an ask or a lesson, which have no fields;
//         Esc goes back to the list
// There are no single-letter keys on a card: every line of a draft takes typing.

import AppKit

extension PanelController {
    func agentKey(_ e: NSEvent) -> Bool {
        let desk = model.desk
        let f = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch desk.mode {
        case .none:
            if e.keyCode == 126, f.isEmpty, model.text.isEmpty, model.target == nil, model.asked == nil, !desk.waiting.isEmpty {
                desk.openList(); return true
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
