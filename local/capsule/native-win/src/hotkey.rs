//! The Capsule's global hotkey: which binding to ask Windows for, and what a focused panel does
//! with it once it's granted. Two decisions the lead and app-design made on 2026-09-28
//! (docs/design/system/components/capsule-windows.md, docs/design/windows-plan.md section 9),
//! turned into code here so they're enforced rather than just written down:
//!
//! 1. Default binding is Alt+Space, the same convention PowerToys Run and Raycast for Windows
//!    use. `RegisterHotKey` wins over Windows' own Alt+Space system-menu handling when nothing
//!    else already holds the key. If registration fails (another app holds it), the fallback is
//!    Ctrl+Alt+Space, and the person is told once, not silently swapped.
//! 2. Alt+Space is *also* Windows' reserved shortcut for the active window's system menu. Once
//!    the Capsule panel itself has focus, a native Alt+Space keydown could reopen that system
//!    menu on a borderless window that has none to show, instead of closing the panel. The
//!    panel's own keydown handler must intercept it and close the panel *before* that can
//!    happen: `must_preempt_system_menu` is the pure decision behind that handler.
//!
//! What's not here yet: the actual `RegisterHotKey`/`tauri-plugin-global-shortcut` call, and the
//! toast telling the person about a fallback. Those need a real Windows process and belong in
//! the Tauri app shell once it exists (windows-plan.md section 9's Sequencing). This module is
//! deliberately host-independent so it builds and tests on any platform.

/// A hotkey binding: modifiers plus one key, in the vocabulary the person sees in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub alt: bool,
    pub ctrl: bool,
    pub key: &'static str,
}

/// The default the Capsule asks Windows for first.
pub const DEFAULT: Binding = Binding { alt: true, ctrl: false, key: "Space" };

/// The fallback, used only when `DEFAULT` fails to register (another app already holds it).
pub const FALLBACK: Binding = Binding { alt: true, ctrl: true, key: "Space" };

impl Binding {
    /// Human-readable form, matching Settings' own wording ("Alt+Space", "Ctrl+Alt+Space").
    pub fn label(&self) -> String {
        let mut parts = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.alt {
            parts.push("Alt");
        }
        parts.push(self.key);
        parts.join("+")
    }

    /// Windows' own reserved shortcut for the active window's system menu is Alt+Space with no
    /// other modifier. Only the default binding collides with it; Ctrl+Alt+Space does not, which
    /// is exactly why it's the fallback and not some other combination.
    pub fn is_system_menu_shortcut(&self) -> bool {
        self.alt && !self.ctrl && self.key == "Space"
    }
}

/// Which binding to try given whether the default's `RegisterHotKey` call succeeded. Pure
/// decision, no Win32 call here: the app shell calls `RegisterHotKey(DEFAULT)` itself, and hands
/// the boolean result to this function to learn what to actually bind and whether to tell the
/// person about it.
pub fn choose(default_registered: bool) -> (Binding, bool) {
    if default_registered {
        (DEFAULT, false)
    } else {
        (FALLBACK, true) // true: tell the person once, per the no-nagging rule (only this once).
    }
}

/// Plain toggle logic: the panel closes when its own active hotkey is pressed again while it has
/// focus, whichever binding that happens to be. This alone says nothing about *how* the app has
/// to intercept the keypress; see `must_preempt_system_menu` for the one binding where that
/// matters.
pub fn should_close_panel_on(active: Binding, pressed: Binding) -> bool {
    active == pressed
}

/// The one behavior app-design flagged and the lead resolved: when the active binding is the
/// bare Alt+Space (the default), the app's own keydown handler must swallow the event, return
/// early from `WM_SYSKEYDOWN`, before `DefWindowProc`, or Windows' native system-menu handling
/// runs too and reopens the system menu on a borderless window that has none to show. The
/// fallback, Ctrl+Alt+Space, has no such collision: Windows has no reserved meaning for it, so a
/// normal keydown handler closing the panel is already enough, nothing to preempt.
pub fn must_preempt_system_menu(active: Binding) -> bool {
    active.is_system_menu_shortcut()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_alt_space() {
        assert_eq!(DEFAULT.label(), "Alt+Space");
        assert!(DEFAULT.is_system_menu_shortcut());
    }

    #[test]
    fn fallback_is_ctrl_alt_space_and_does_not_collide_with_the_system_menu() {
        assert_eq!(FALLBACK.label(), "Ctrl+Alt+Space");
        assert!(!FALLBACK.is_system_menu_shortcut());
    }

    #[test]
    fn choose_keeps_the_default_silently_when_registration_succeeds() {
        let (binding, tell) = choose(true);
        assert_eq!(binding, DEFAULT);
        assert!(!tell, "no nagging when the default just works");
    }

    #[test]
    fn choose_falls_back_and_tells_the_person_once_when_registration_fails() {
        let (binding, tell) = choose(false);
        assert_eq!(binding, FALLBACK);
        assert!(tell, "a silent swap would leave the person guessing why their hotkey changed");
    }

    #[test]
    fn the_panel_toggles_closed_on_its_own_active_binding_whichever_one_that_is() {
        assert!(should_close_panel_on(DEFAULT, DEFAULT));
        assert!(should_close_panel_on(FALLBACK, FALLBACK));
    }

    #[test]
    fn a_keypress_that_is_not_the_active_binding_never_closes_the_panel() {
        // The fallback is active; a bare Alt+Space reaching the panel is not this app's hotkey
        // (some other app's, or nothing at all), so it is left alone, not treated as a toggle.
        assert!(!should_close_panel_on(FALLBACK, DEFAULT));
        assert!(!should_close_panel_on(DEFAULT, FALLBACK));
    }

    #[test]
    fn only_the_default_binding_needs_the_system_menu_preempted() {
        assert!(must_preempt_system_menu(DEFAULT));
        assert!(!must_preempt_system_menu(FALLBACK), "Ctrl+Alt+Space has no OS shortcut to race");
    }
}
