#!/usr/bin/env python3
"""
Helper for the Unified Tray applet: reads a GTK (or any AT-SPI-exposed) popup
menu that an application has just opened, and can activate its items later.

Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
On start-up a {"hello": true, "epoch": N} line is printed; item ids are only valid for the
epoch (process) that issued them.

  {"req": 1, "cmd": "scan", "pid": 1234}            -> {"req": 1, "epoch": N, "items": [...]} | {"req": 1, "error": "..."}
  {"req": 2, "cmd": "do", "id": 17, "epoch": N}     -> {"req": 2, "ok": true}
  {"req": 3, "cmd": "close"}                        -> {"req": 3, "ok": true}   (sends Escape to dismiss the popup)
"""
import json
import random
import re
import sys
import time

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.init()
except Exception as e:  # missing typelib, no a11y bus ...
    sys.stdout.write(json.dumps({"fatal": "AT-SPI unavailable (install gir1.2-atspi-2.0 / at-spi2-core): %s" % e}) + "\n")
    sys.stdout.flush()
    sys.exit(1)

R = Atspi.Role
S = Atspi.StateType
ITEM_ROLES = (R.MENU_ITEM, R.CHECK_MENU_ITEM, R.RADIO_MENU_ITEM)
CONTAINER_ROLES = (R.MENU, R.POPUP_MENU)
ICON_ROLES = (R.IMAGE, R.ICON)
# Normal application windows never hold a popup menu; skipping them keeps the search fast.
SKIP_WINDOW_ROLES = (R.FRAME, R.DIALOG, R.FILE_CHOOSER, R.ALERT)
ICON_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-/]*$")

EPOCH = random.randint(1, 2 ** 31 - 1)

nodes = {}        # item id -> accessible
pid_nodes = {}    # pid -> set of item ids issued for it
_apps = {}        # pid -> [application accessibles]
_counter = [0]


def say(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def has_state(acc, state):
    ss = safe(acc.get_state_set)
    return bool(ss is not None and safe(lambda: ss.contains(state), False))


def children(acc):
    safe(acc.clear_cache)
    count = safe(acc.get_child_count, 0) or 0
    for i in range(count):
        child = safe(lambda: acc.get_child_at_index(i))
        if child is not None:
            yield child


def apps_for_pid(pid):
    cached = _apps.get(pid)
    if cached:
        alive = [a for a in cached if safe(a.get_child_count) is not None]
        if alive:
            _apps[pid] = alive
            return alive
        _apps.pop(pid, None)
    found = []
    desktop = Atspi.get_desktop(0)
    safe(desktop.clear_cache)
    count = safe(desktop.get_child_count, 0) or 0
    for i in range(count):
        app = safe(lambda: desktop.get_child_at_index(i))
        if app is not None and safe(app.get_process_id) == pid:
            found.append(app)
    if found:
        _apps[pid] = found
    return found


def find_menu(acc, depth):
    role = safe(acc.get_role)
    if role in CONTAINER_ROLES and has_state(acc, S.SHOWING):
        if any(safe(k.get_role) in ITEM_ROLES for k in children(acc)):
            return acc
    if depth >= 3 or role in ITEM_ROLES or role == R.MENU_BAR:
        return None
    for child in children(acc):
        found = find_menu(child, depth + 1)
        if found is not None:
            return found
    return None


def find_popup(app):
    """Look only at the application's top-level windows, skipping ordinary frames/dialogs."""
    for win in children(app):
        if safe(win.get_role) in SKIP_WINDOW_ROLES:
            continue
        if not has_state(win, S.SHOWING):
            continue
        found = find_menu(win, 0)
        if found is not None:
            return found
    return None


def find_icon(item, depth=0):
    """GTK exposes an unlabeled image's icon name as its accessible name."""
    if depth > 2:
        return None
    for child in children(item):
        role = safe(child.get_role)
        if role in CONTAINER_ROLES:
            continue
        if role in ICON_ROLES:
            name = safe(child.get_name, "") or ""
            if name and ICON_NAME_RE.match(name):
                return name
        else:
            found = find_icon(child, depth + 1)
            if found:
                return found
    return None


def read_menu(menu, pid, depth=0):
    items = []
    if depth > 6:
        return items
    for child in children(menu):
        role = safe(child.get_role)
        if role == R.SEPARATOR:
            items.append({"sep": True})
            continue
        if role not in ITEM_ROLES:
            continue
        if not has_state(child, S.VISIBLE) and not has_state(child, S.SHOWING):
            continue
        _counter[0] += 1
        nid = _counter[0]
        nodes[nid] = child
        pid_nodes.setdefault(pid, set()).add(nid)
        entry = {
            "id": nid,
            "label": safe(child.get_name, "") or "",
            "enabled": has_state(child, S.SENSITIVE) or has_state(child, S.ENABLED),
            "toggle": None,
            "checked": has_state(child, S.CHECKED),
            "icon": find_icon(child),
            "children": [],
        }
        if role == R.CHECK_MENU_ITEM:
            entry["toggle"] = "checkmark"
        elif role == R.RADIO_MENU_ITEM:
            entry["toggle"] = "radio"
        for sub in children(child):
            if safe(sub.get_role) in CONTAINER_ROLES:
                entry["children"] = read_menu(sub, pid, depth + 1)
                break
        items.append(entry)
    return items


def scan(pid, timeout=1.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for app in apps_for_pid(pid):
            popup = find_popup(app)
            if popup is not None:
                for old in pid_nodes.pop(pid, ()):
                    nodes.pop(old, None)
                items = read_menu(popup, pid)
                if items:
                    return {"items": items, "epoch": EPOCH}
        time.sleep(0.03)
    return {"error": "no popup menu found for pid %s (is toolkit accessibility enabled?)" % pid}


def do_action(nid, epoch):
    if epoch is not None and epoch != EPOCH:
        return {"ok": False, "error": "stale item (helper restarted)"}
    acc = nodes.get(nid)
    if acc is None:
        return {"ok": False, "error": "unknown item"}
    try:
        ok = Atspi.Action.do_action(acc, 0)
    except Exception:
        try:
            ok = acc.get_action_iface().do_action(0)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": bool(ok)}


def close_popup():
    try:
        Atspi.generate_keyboard_event(0xFF1B, "", Atspi.KeySynthType.SYM)  # Escape
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main():
    say(json.dumps({"hello": True, "epoch": EPOCH}))
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        cmd = req.get("cmd")
        try:
            if cmd == "scan":
                resp = scan(int(req.get("pid", 0)))
            elif cmd == "do":
                resp = do_action(int(req.get("id", 0)), req.get("epoch"))
            elif cmd == "close":
                resp = close_popup()
            else:
                resp = {"error": "unknown command"}
        except Exception as e:
            resp = {"error": str(e)}
        resp["req"] = req.get("req")
        say(json.dumps(resp))


if __name__ == "__main__":
    main()
