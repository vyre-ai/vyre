#!/usr/bin/env python3
"""atspi: the AT-SPI side of computerd. Talks to the desktop bus; computerd/index.js talks HTTP.

AT-SPI2's usable binding is Python (modules/hands-desktop/snapshot.js's header comment, and
bin/desktop.cjs made the same call for the Mac's own AT-SPI hands). Bookworm's binding is the
GObject-introspection one, `gi.repository.Atspi`, not the older standalone python3-pyatspi
package (gone from current Debian). One process per call, invoked by computerd as a subprocess
and talked to over stdout as one line of JSON: AT-SPI's D-Bus calls are synchronous enough, and
there is no reason to keep a Python process warm across the small, bursty calls computerd makes.

Three subcommands, matching the routes in docs/work/computers.md's computerd table:

  atspi.py apps                         -> [{name, pid, windows: [title]}]
  atspi.py tree [--app NAME]            -> {window, nodes: [...]}   (no --app: the focused app)
  atspi.py act PATH ACTION [VALUE]      -> {ok: true} or raises

UNVALIDATED: written by inspection, never run against a live AT-SPI bus. See the report to the
lead for what needs checking once the box is up. In particular: whether Atspi.get_desktop(0)
enumerates Chromium's tab/page accessible objects the way GTK apps' are enumerated (Chromium's
AT-SPI surface is its own renderer-side implementation, not GTK's), and whether
`--force-renderer-accessibility` in entrypoint.sh is sufficient for that tree to be populated
without a real screen reader having attached first (Chromium has historically been lazier than
that flag alone in some versions).
"""

import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

# Roles worth walking at all. Kept wide on purpose: modules/hands-desktop/snapshot.js does the
# real filtering down to ACTIONABLE roles, client-side, from the raw role name this sends. Being
# too narrow here would silently drop a role no one has seen yet; being too wide only costs one
# JSON node computerd's caller ignores.
_SKIP_ROLES = {"invalid", "redundant object", "unknown"}

_STATE_FOCUSED = getattr(Atspi.StateType, "FOCUSED", None)
_STATE_ENABLED = getattr(Atspi.StateType, "ENABLED", None)
_STATE_SHOWING = getattr(Atspi.StateType, "SHOWING", None)


def _text(err):
    return str(err)


def _role_name(acc):
    try:
        return acc.get_role_name()
    except Exception:
        return "unknown"


def _name(acc):
    try:
        return acc.get_name() or ""
    except Exception:
        return ""


def _description(acc):
    try:
        return acc.get_description() or ""
    except Exception:
        return ""


def _has_state(acc, state):
    if state is None:
        return False
    try:
        return bool(acc.get_state_set().contains(state))
    except Exception:
        return False


def _extents(acc):
    try:
        comp = acc.get_component_iface()
        if not comp:
            return None
        rect = comp.get_extents(Atspi.CoordType.SCREEN)
        if rect.width <= 0 or rect.height <= 0:
            return None
        return {"x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height}
    except Exception:
        return None


def _value(acc):
    # Text-bearing controls (entry, text) read through the Text interface; anything with a
    # numeric range (slider, spin button) reads through Value. Either, first match wins, since a
    # node only usefully has one.
    try:
        text_iface = acc.get_text_iface()
        if text_iface:
            n = text_iface.get_character_count()
            if n:
                s = text_iface.get_text(0, n)
                if s:
                    return s
    except Exception:
        pass
    try:
        value_iface = acc.get_value_iface()
        if value_iface:
            return value_iface.get_current_value()
    except Exception:
        pass
    return None


def _pid_of(app):
    try:
        return app.get_process_id()
    except Exception:
        return -1


def _windows_of(app):
    titles = []
    try:
        for i in range(app.get_child_count()):
            child = app.get_child_at_index(i)
            if child is None:
                continue
            if _role_name(child) == "frame":
                titles.append(_name(child))
    except Exception:
        pass
    return titles


def list_apps():
    desktop = Atspi.get_desktop(0)
    out = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        out.append({"name": _name(app), "pid": _pid_of(app), "windows": _windows_of(app)})
    return out


def _find_app(name):
    desktop = Atspi.get_desktop(0)
    focused = None
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        if name and _name(app) == name:
            return app
        if not name and focused is None:
            # No app named: computerd asks for "the focused one". AT-SPI has no single "which
            # app is focused" query, so this walks each app's frame for a FOCUSED descendant and
            # takes the first app that has one; falls back to the first app if none report focus.
            if _subtree_has_focus(app):
                focused = app
    if name:
        return None
    if focused is not None:
        return focused
    return desktop.get_child_at_index(0) if desktop.get_child_count() else None


def _subtree_has_focus(acc, depth=0):
    if depth > 6:
        return False
    if _has_state(acc, _STATE_FOCUSED):
        return True
    try:
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is not None and _subtree_has_focus(child, depth + 1):
                return True
    except Exception:
        pass
    return False


def _window_title(app):
    try:
        for i in range(app.get_child_count()):
            child = app.get_child_at_index(i)
            if child is not None and _role_name(child) == "frame":
                return _name(child)
    except Exception:
        pass
    return ""


def _walk(acc, path, depth, out, max_depth=40):
    if depth > max_depth:
        return
    role = _role_name(acc)
    if role not in _SKIP_ROLES:
        node = {
            "path": path,
            "role": role,
            "name": _name(acc),
            "description": _description(acc),
            "enabled": _has_state(acc, _STATE_ENABLED),
            "focused": _has_state(acc, _STATE_FOCUSED),
        }
        value = _value(acc)
        if value not in (None, ""):
            node["value"] = value
        extents = _extents(acc)
        if extents:
            node.update(extents)
        # A node is a "container" (for the caller's own layout sense, not filtered here) when it
        # has children and is not one of the interactive leaf roles hands-desktop treats as
        # actionable. Left as the role name itself when so, matching Control.container's use as
        # an identifier rather than a boolean (modules/hands-desktop/snapshot.js reads it as a
        # string, `if (n.container) c.container = String(n.container)`).
        try:
            has_children = acc.get_child_count() > 0
        except Exception:
            has_children = False
        if has_children:
            node["container"] = role
        out.append(node)
    try:
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is not None:
                _walk(child, f"{path}.{i}" if path else str(i), depth + 1, out)
    except Exception:
        pass


def tree(app_name):
    app = _find_app(app_name)
    if app is None:
        raise RuntimeError(f"no such app: {app_name!r}" if app_name else "no app is focused")
    nodes = []
    _walk(app, "", 0, nodes)
    return {"window": _window_title(app), "nodes": nodes}


def _find_by_path(app_name, path):
    app = _find_app(app_name)
    if app is None:
        raise RuntimeError(f"no such app: {app_name!r}" if app_name else "no app is focused")
    if path == "":
        return app
    acc = app
    for part in path.split("."):
        idx = int(part)
        acc = acc.get_child_at_index(idx)
        if acc is None:
            raise RuntimeError(f"path {path!r} does not resolve in {app_name!r}")
    return acc


def act(app_name, path, action, value=None):
    acc = _find_by_path(app_name, path)
    if action == "focus":
        comp = acc.get_component_iface()
        if not comp or not comp.grab_focus():
            raise RuntimeError("could not focus this control")
        return {"ok": True}
    if action == "press":
        action_iface = acc.get_action_iface()
        if not action_iface or action_iface.get_n_actions() < 1:
            raise RuntimeError("this control has no AT-SPI action to press")
        # "press"/"activate"/"click" all show up under different names depending on the toolkit;
        # take whichever the control actually offers rather than assuming index 0 is it.
        names = [action_iface.get_action_name(i) for i in range(action_iface.get_n_actions())]
        idx = 0
        for i, n in enumerate(names):
            if str(n).lower() in ("press", "click", "activate"):
                idx = i
                break
        if not action_iface.do_action(idx):
            raise RuntimeError(f"the {names[idx] if names else 'default'} action did not accept")
        return {"ok": True}
    if action == "set-text":
        editable = acc.get_editable_text_iface()
        if not editable:
            raise RuntimeError("this control has no editable text interface")
        text_iface = acc.get_text_iface()
        n = text_iface.get_character_count() if text_iface else 0
        if n and not editable.delete_text(0, n):
            raise RuntimeError("could not clear the existing text")
        if not editable.insert_text(0, value or "", len(value or "")):
            raise RuntimeError("could not set the text")
        return {"ok": True}
    raise RuntimeError(f"unknown action {action!r}")


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "no subcommand"}), file=sys.stderr)
        sys.exit(2)
    cmd = args[0]
    try:
        if cmd == "apps":
            print(json.dumps(list_apps()))
        elif cmd == "tree":
            app_name = ""
            if len(args) >= 3 and args[1] == "--app":
                app_name = args[2]
            print(json.dumps(tree(app_name)))
        elif cmd == "act":
            # act PATH ACTION [VALUE] [--app NAME]
            rest = args[1:]
            app_name = ""
            if "--app" in rest:
                i = rest.index("--app")
                app_name = rest[i + 1]
                rest = rest[:i] + rest[i + 2:]
            path, action = rest[0], rest[1]
            value = rest[2] if len(rest) > 2 else None
            print(json.dumps(act(app_name, path, action, value)))
        else:
            print(json.dumps({"error": f"unknown subcommand {cmd!r}"}), file=sys.stderr)
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 - this process's whole job is to report the failure
        print(json.dumps({"error": _text(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
