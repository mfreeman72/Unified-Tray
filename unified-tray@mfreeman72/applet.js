/*
 * Unified Tray - a Cinnamon applet replacing "XApp Status" and "System Tray".
 *
 * Icon display, sizing, tooltips, click/scroll forwarding and orientation
 * handling for XApp icons are ported from Cinnamon's xapp-status@cinnamon.org
 * applet, so icons look and size exactly as they did there. StatusNotifier
 * items use the same code path (they are what xapp-sn-watcher turns into XApp
 * icons), and legacy XEmbed icons are sized like the systray@cinnamon.org applet.
 *
 * Menus
 *   - StatusNotifier items: the com.canonical.dbusmenu is read over D-Bus and
 *     rebuilt as a native Cinnamon menu; activations are sent back over D-Bus.
 *   - Native XApp icons (GTK menu living inside the application): the applet
 *     asks the app to open its menu, hides that popup, reads it through AT-SPI
 *     (gtk-menu-helper.py), closes it and rebuilds it as a Cinnamon menu.
 *     Activating an item invokes the original GTK menu item through AT-SPI.
 *     If any step fails, the app's own menu is shown instead.
 */

const Applet = imports.ui.applet;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;

let XApp = null;
try {
    XApp = imports.gi.XApp;
} catch (e) {
    XApp = null;
}

const UUID = "unified-tray@mfreeman72";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
function _(str) {
    let custom = Gettext.dgettext(UUID, str);
    if (custom !== str)
        return custom;
    return Gettext.gettext(str);
}

const EVENT_STOP = true;
const EVENT_PROPAGATE = false;

const SNI_IFACE = "org.kde.StatusNotifierItem";
const SNI_WATCHER = "org.kde.StatusNotifierWatcher";
const SNI_WATCHER_PATH = "/StatusNotifierWatcher";
const DBUSMENU_IFACE = "com.canonical.dbusmenu";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";

/* Same container styles as the stock xapp-status applet */
const HORIZONTAL_STYLE = "padding-left: 2px; padding-right: 2px; padding-top: 0; padding-bottom: 0";
const VERTICAL_STYLE = "padding-left: 0; padding-right: 0; padding-top: 2px; padding-bottom: 2px";

/* ------------------------------------------------------------------------ */
/* Generic helpers                                                          */
/* ------------------------------------------------------------------------ */

function warn(msg, e) {
    global.logWarning("[" + UUID + "] " + msg + (e ? ": " + e : ""));
}

function isVertical(orientation) {
    return orientation === St.Side.LEFT || orientation === St.Side.RIGHT;
}

function bytesToString(data) {
    if (typeof data === "string")
        return data;
    if (typeof TextDecoder !== "undefined")
        return new TextDecoder().decode(data);
    return ByteArray.toString(data);
}

/* Async D-Bus call on the session bus; cb(variant|null, error|null) */
function sessionCall(busName, path, iface, method, params, replyType, cb) {
    Gio.DBus.session.call(
        busName, path, iface, method, params,
        replyType ? GLib.VariantType.new(replyType) : null,
        Gio.DBusCallFlags.NONE, 5000, null,
        (conn, res) => {
            let out = null;
            let err = null;
            try {
                out = conn.call_finish(res);
            } catch (e) {
                err = e;
            }
            cb(out, err);
        });
}

function getBusPid(name, cb) {
    sessionCall("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "GetConnectionUnixProcessID", new GLib.Variant("(s)", [name]), "(u)",
        (res) => {
            let pid = 0;
            try {
                if (res)
                    pid = res.deepUnpack()[0];
            } catch (e) { /* ignore */ }
            cb(pid);
        });
}

function readCmdline(pid) {
    try {
        let [ok, data] = GLib.file_get_contents("/proc/" + pid + "/cmdline");
        if (!ok)
            return [];
        return bytesToString(data).split("\0").filter(s => s.length > 0);
    } catch (e) {
        return [];
    }
}

const GENERIC_PROCS = /^(python[\d.]*|sh|bash|dash|env|java|node|nodejs|electron|perl|ruby|wine|wine64|flatpak|snap|bwrap|dbus-launch|mono|xdg-.*)$/;

let _appInfos = null;
let _appInfosAt = 0;

/* First .desktop application for which match({id, last, exe, wm, name}) is true */
function findApp(match) {
    let now = GLib.get_monotonic_time();
    if (!_appInfos || now - _appInfosAt > 30e6) {
        _appInfos = Gio.AppInfo.get_all();
        _appInfosAt = now;
    }
    for (let info of _appInfos) {
        let id = (info.get_id() || "").toLowerCase().replace(/\.desktop$/, "");
        let exe = "";
        let wm = "";
        try {
            exe = GLib.path_get_basename(info.get_executable() || "").toLowerCase();
            wm = String((typeof info.get_startup_wm_class === "function" && info.get_startup_wm_class()) || "").toLowerCase();
        } catch (e) { /* not a desktop application */ }
        let name = String(info.get_name() || "").toLowerCase();
        if (match({ id: id, last: id.split(".").pop(), exe: exe, wm: wm, name: name }))
            return { name: info.get_name(), gicon: info.get_icon(), id: id, wmClass: wm };
    }
    return null;
}

/* Map a process id to its .desktop application (name + icon), best effort. */
function resolveApp(pid) {
    let tokens = [];
    for (let a of readCmdline(pid).slice(0, 4)) {
        if (a.startsWith("-"))
            continue;
        let t = GLib.path_get_basename(a).toLowerCase().replace(/\.(py|pyc|sh|js|exe|appimage|desktop|bin)$/, "");
        if (t && !GENERIC_PROCS.test(t))
            tokens.push(t);
    }
    for (let t of tokens) {
        let app = findApp(k => t === k.id || t === k.last || (k.exe && t === k.exe));
        if (app)
            return app;
    }
    return null;
}

/* Find the application whose id, executable, name or window class equals one of the hints */
function resolveAppByHint(hints) {
    let hs = hints.map(h => prettyName(h).toLowerCase()).filter(h => h.length >= 3);
    if (hs.length === 0)
        return null;
    return findApp(k => hs.some(h => h === k.id || h === k.last || (k.exe && h === k.exe) ||
        (k.wm && h === k.wm) || h === k.name));
}

/* "android-messages-desktop" -> "Android-Messages-Desktop": capitalise every word, whatever separates it */
function titleCase(str) {
    return String(str || "").replace(/(^|[^\p{L}\p{N}'\u2019])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

/* Turn an id-like name (file extension, reverse-DNS id, ...) into something readable */
function prettyName(raw) {
    let n = String(raw || "").trim().replace("org.x.StatusIcon.", "");
    n = n.replace(/\.(py|pyc|sh|js|exe|bin|appimage)$/i, "");
    n = n.replace(/[_-]?(status|tray|app)[_-]?icon[_-]?\d*$/i, "");
    if (/^[a-z][a-z0-9]*(\.[A-Za-z0-9_-]+){2,}$/.test(n))
        n = n.split(".").pop();
    return n;
}

function cleanLabel(label) {
    /* mnemonics: "_File" -> "File", "__" -> "_" */
    return String(label || "").replace(/__/g, "\u0001").replace(/_/g, "").replace(/\u0001/g, "_");
}

function looksLikeOpen(label, appName) {
    let l = cleanLabel(label).trim();
    if (!/^(open|show|restore|launch|start|view)\b/i.test(l))
        return false;
    let lower = l.toLowerCase();
    let words = String(appName || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
    if (words.some(w => lower.indexOf(w) >= 0))
        return true;
    return /^(open|show|restore)( the)?( (main |application )?(window|app|application))?$/i.test(l);
}

/* ------------------------------------------------------------------------ */
/* Icon helpers (SNI pixmaps are saved to a file, like xapp-sn-watcher does) */
/* ------------------------------------------------------------------------ */

const _addedThemePaths = new Set();
function addThemePath(path) {
    if (!path || _addedThemePaths.has(path))
        return;
    _addedThemePaths.add(path);
    try {
        Gtk.IconTheme.get_default().append_search_path(path);
    } catch (e) { /* ignore */ }
}

/* SNI IconPixmap: a(iiay), ARGB32 in network byte order. */
function hashBytes(d) {
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) {
        h ^= d[i];
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function pickPixmap(pixmaps, size) {
    let best = null;
    for (let p of pixmaps) {
        if (!p || p.length < 3 || p[0] <= 0 || p[1] <= 0)
            continue;
        if (!best) {
            best = p;
            continue;
        }
        let bOk = best[0] >= size;
        let pOk = p[0] >= size;
        if (pOk && !bOk)
            best = p;
        else if (pOk && bOk && p[0] < best[0])
            best = p;
        else if (!pOk && !bOk && p[0] > best[0])
            best = p;
    }
    return best;
}

let _pixmapCounter = 0;

/* Returns the path of a PNG written from the pixmap, or null. */
function savePixmapFile(pixmaps, size, tag, oldPath) {
    let best = pickPixmap(pixmaps, size);
    if (!best)
        return null;
    let w = best[0];
    let h = best[1];
    let data = best[2];
    if (!(data instanceof Uint8Array))
        data = Uint8Array.from(data);
    if (data.length < w * h * 4)
        return null;

    let rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        let o = i * 4;
        rgba[o] = data[o + 1];
        rgba[o + 1] = data[o + 2];
        rgba[o + 2] = data[o + 3];
        rgba[o + 3] = data[o];
    }

    try {
        let pb = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(rgba),
            GdkPixbuf.Colorspace.RGB, true, 8, w, h, w * 4);
        let dir = GLib.build_filenamev([GLib.get_user_cache_dir(), "unified-tray"]);
        GLib.mkdir_with_parents(dir, 0o755);
        let path = GLib.build_filenamev([dir, tag.replace(/[^A-Za-z0-9_.-]/g, "_") + "-" + (++_pixmapCounter) + ".png"]);
        pb.savev(path, "png", [], []);
        if (oldPath) {
            try {
                Gio.File.new_for_path(oldPath).delete(null);
            } catch (e) { /* ignore */ }
        }
        return path;
    } catch (e) {
        warn("could not store icon pixmap", e);
        return null;
    }
}

/* ------------------------------------------------------------------------ */
/* Menu building                                                            */
/* ------------------------------------------------------------------------ */

const MENU_ICON_SIZE = 16;

/*
 * Every item is a single child (an St.BoxLayout) so that PopupBaseMenuItem's
 * column logic can't stretch the icon column to the width of other items'
 * labels. If reserveIcon is set, items without an icon get an empty
 * placeholder so that all labels in the menu line up.
 */
let _applet = null;   // the running applet instance (so menu items can close its menu)

function makeMenuItem(text, iconActor, reserveIcon) {
    let item = new PopupMenu.PopupBaseMenuItem();
    /* Choosing an entry closes the menu (connected first, so it also happens if a later handler fails) */
    item.connect("activate", (it, event, keepMenu) => {
        if (!keepMenu && _applet && _applet.menu)
            _applet.menu.close(true);
    });
    let box = new St.BoxLayout({ style: "spacing: 6px;" });
    if (iconActor) {
        iconActor.y_align = Clutter.ActorAlign.CENTER;
        box.add_actor(iconActor);
    } else if (reserveIcon) {
        box.add_actor(new St.Bin({ width: MENU_ICON_SIZE, height: MENU_ICON_SIZE }));
    }
    item.label = new St.Label({ text: text, y_align: Clutter.ActorAlign.CENTER });
    box.add_actor(item.label);
    item.addActor(box, { span: -1, expand: true });
    item.actor.label_actor = item.label;
    return item;
}

function applyOrnament(item, toggleType, on, label) {
    try {
        if (typeof item.setOrnament === "function" && PopupMenu.OrnamentType) {
            item.setOrnament(toggleType === "radio" ? PopupMenu.OrnamentType.DOT : PopupMenu.OrnamentType.CHECK, on);
            return;
        }
    } catch (e) { /* fall back below */ }
    let mark = on ? (toggleType === "radio" ? "\u25CF " : "\u2713 ") : "    ";
    item.label.set_text(mark + label);
}

/*
 * Turns a dbusmenu-shaped layout node [id, props, children] into Cinnamon
 * menu items. Subclasses provide the transport for activations.
 */
class MenuBuilder {
    sendEvent(id, type) { /* subclass */ }
    onSubmenuState(id, item, open) { /* subclass */ }

    _visibleItems(node) {
        let kids = (node && node[2]) || [];
        return kids.filter(k => k[1].visible !== false && k[1].type !== "separator");
    }

    populate(shell, reserveIcon) {
        if (this.layout)
            this._buildChildren(shell, this.layout, !!reserveIcon);
    }

    hasItems() {
        return !!this.layout && this._visibleItems(this.layout).length > 0;
    }

    hasOpenLikeItem(appName) {
        if (!this.layout)
            return false;
        let first = this._visibleItems(this.layout).slice(0, 3);
        return first.some(k => looksLikeOpen(k[1].label, appName));
    }

    _buildChildren(shell, node, reserveIcon) {
        let kids = node[2] || [];
        let anyIcon = !!reserveIcon || kids.some(k => k[1].visible !== false && k[1].type !== "separator" &&
            (k[1]["icon-name"] || (k[1]["icon-data"] && k[1]["icon-data"].length > 0)));
        let pendingSeparator = false;
        let any = false;
        for (let kid of kids) {
            let id = kid[0];
            let props = kid[1] || {};
            let sub = kid[2] || [];
            if (props.visible === false)
                continue;
            if (props.type === "separator") {
                if (any)
                    pendingSeparator = true;
                continue;
            }
            if (pendingSeparator) {
                shell.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                pendingSeparator = false;
            }
            any = true;
            shell.addMenuItem(this._makeItem(id, props, sub, anyIcon));
        }
    }

    _makeItem(id, props, sub, reserveIcon) {
        let label = cleanLabel(props.label);
        let enabled = props.enabled !== false;

        if (props["children-display"] === "submenu" || sub.length > 0) {
            let item = new PopupMenu.PopupSubMenuMenuItem(label);
            this._buildChildren(item.menu, [id, props, sub], false);
            item.setSensitive(enabled);
            item.menu.connect("open-state-changed", (menu, open) => this.onSubmenuState(id, item, open));
            return item;
        }

        let iconActor = null;
        try {
            if (props["icon-name"]) {
                let n = String(props["icon-name"]);
                if (n.startsWith("/")) {
                    iconActor = new St.Icon({
                        gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(n) }),
                        icon_size: MENU_ICON_SIZE,
                        icon_type: St.IconType.FULLCOLOR
                    });
                } else {
                    iconActor = new St.Icon({
                        icon_name: n,
                        icon_size: MENU_ICON_SIZE,
                        icon_type: n.endsWith("-symbolic") ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR
                    });
                }
            } else if (props["icon-data"] && props["icon-data"].length > 0) {
                let gicon = new Gio.BytesIcon({ bytes: new GLib.Bytes(props["icon-data"]) });
                iconActor = new St.Icon({
                    gicon: gicon,
                    icon_size: MENU_ICON_SIZE,
                    icon_type: St.IconType.FULLCOLOR
                });
            }
        } catch (e) {
            iconActor = null;
        }

        let item = makeMenuItem(label, iconActor, reserveIcon);

        let toggleType = props["toggle-type"];
        if (toggleType === "checkmark" || toggleType === "radio")
            applyOrnament(item, toggleType, props["toggle-state"] === 1, label);

        item.setSensitive(enabled);
        item.connect("activate", () => this.sendEvent(id, "clicked"));
        return item;
    }
}

/* ------------------------------------------------------------------------ */
/* com.canonical.dbusmenu client                                            */
/* ------------------------------------------------------------------------ */

class DBusMenuClient extends MenuBuilder {
    constructor(busName, objPath, onExternalChange) {
        super();
        this.busName = busName;
        this.objPath = objPath;
        this.onExternalChange = onExternalChange;
        this.layout = null;      // [id, props, children]
        this.layoutJson = "";
        this.destroyed = false;
        this.changeTimer = 0;
        this.subIds = [];

        let bus = Gio.DBus.session;
        let onSignal = () => this._scheduleChange();
        this.subIds.push(bus.signal_subscribe(busName, DBUSMENU_IFACE, "LayoutUpdated", objPath, null,
            Gio.DBusSignalFlags.NONE, onSignal));
        this.subIds.push(bus.signal_subscribe(busName, DBUSMENU_IFACE, "ItemsPropertiesUpdated", objPath, null,
            Gio.DBusSignalFlags.NONE, onSignal));
    }

    _scheduleChange() {
        if (this.destroyed || this.changeTimer)
            return;
        this.changeTimer = Mainloop.timeout_add(120, () => {
            this.changeTimer = 0;
            if (!this.destroyed)
                this.onExternalChange();
            return false;
        });
    }

    _call(method, params, replyType, cb) {
        sessionCall(this.busName, this.objPath, DBUSMENU_IFACE, method, params, replyType,
            (res, err) => {
                if (!this.destroyed)
                    cb(res, err);
            });
    }

    /* AboutToShow(root), then fetch the whole layout. */
    prepare(cb) {
        this._call("AboutToShow", new GLib.Variant("(i)", [0]), "(b)", () => {
            this.fetch(() => cb());
        });
    }

    /* cb(changed:boolean) */
    fetch(cb) {
        this._call("GetLayout", new GLib.Variant("(iias)", [0, -1, []]), "(u(ia{sv}av))", (res, err) => {
            let changed = false;
            if (res) {
                try {
                    let un = res.recursiveUnpack();
                    let json = JSON.stringify(un[1]);
                    changed = json !== this.layoutJson;
                    this.layoutJson = json;
                    this.layout = un[1];
                } catch (e) {
                    warn("bad dbusmenu layout from " + this.busName, e);
                }
            } else if (err) {
                warn("GetLayout failed for " + this.busName, err);
            }
            cb(changed);
        });
    }

    sendEvent(id, type) {
        let ts = Math.floor(Date.now() / 1000) >>> 0;
        this._call("Event",
            new GLib.Variant("(isvu)", [id, type, new GLib.Variant("i", 0), ts]),
            null, () => { /* fire and forget */ });
    }

    onSubmenuState(id, item, open) {
        if (open) {
            this._call("AboutToShow", new GLib.Variant("(i)", [id]), "(b)", (res) => {
                let needUpdate = false;
                try {
                    needUpdate = !!res && res.deepUnpack()[0];
                } catch (e) { /* ignore */ }
                if (!needUpdate)
                    return;
                this._call("GetLayout", new GLib.Variant("(iias)", [id, -1, []]), "(u(ia{sv}av))", (r) => {
                    if (!r)
                        return;
                    try {
                        let node = r.recursiveUnpack()[1];
                        item.menu.removeAll();
                        this._buildChildren(item.menu, node, false);
                    } catch (e) {
                        warn("could not refresh submenu", e);
                    }
                });
            });
            this.sendEvent(id, "opened");
        } else {
            this.sendEvent(id, "closed");
        }
    }

    destroy() {
        this.destroyed = true;
        if (this.changeTimer) {
            Mainloop.source_remove(this.changeTimer);
            this.changeTimer = 0;
        }
        for (let id of this.subIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this.subIds = [];
    }
}

/* ------------------------------------------------------------------------ */
/* GTK menu bridge (AT-SPI through gtk-menu-helper.py)                      */
/* ------------------------------------------------------------------------ */

function stripIds(items) {
    return items.map(it => {
        if (it.sep)
            return { sep: true };
        return {
            label: it.label, enabled: it.enabled, toggle: it.toggle, checked: it.checked, icon: it.icon || null,
            children: stripIds(it.children || [])
        };
    });
}

/* Find the item id (in a scanned item tree) that has the given label path */
function findItemByPath(items, path) {
    let level = items;
    let found = null;
    for (let label of path) {
        found = (level || []).find(it => !it.sep && String(it.label || "") === label);
        if (!found)
            return null;
        level = found.children;
    }
    return found ? found.id : null;
}

/* Translate scanned GTK menu items into a dbusmenu-shaped layout. targets maps local ids -> {gtkId, path}. */
function gtkItemsToLayout(items, targets) {
    let counter = 0;
    let convert = (it, parentPath) => {
        if (it.sep)
            return [0, { type: "separator" }, []];
        let label = String(it.label || "");
        let path = parentPath.concat([label]);
        let local = ++counter;
        targets[local] = { gtkId: it.id || 0, path: path };
        let kids = (it.children || []).map(c => convert(c, path));
        let props = {
            label: label,
            enabled: it.enabled !== false,
            "children-display": kids.length > 0 ? "submenu" : ""
        };
        if (it.icon)
            props["icon-name"] = it.icon;
        if (it.toggle) {
            props["toggle-type"] = it.toggle;
            props["toggle-state"] = it.checked ? 1 : 0;
        }
        return [local, props, kids];
    };
    return [0, { "children-display": "submenu" }, items.map(it => convert(it, []))];
}

class GtkMenuSource extends MenuBuilder {
    constructor(items, entry) {
        super();
        this.entry = entry;
        this.targets = {};
        this.layout = gtkItemsToLayout(items, this.targets);
    }

    sendEvent(id, type) {
        let target = this.targets[id];
        if (type === "clicked" && target)
            this.entry.activateGtkItem(target.gtkId, target.path);
    }
}

class GtkMenuBridge {
    constructor(helperPath) {
        this.helperPath = helperPath;
        this.proc = null;
        this.stdin = null;
        this.stdout = null;
        this.pending = new Map();
        this.nextReq = 1;
        this.unusable = false;
        this.reportedFatal = false;
        this.epoch = 0;
    }

    usable() {
        return !this.unusable;
    }

    _start() {
        if (this.proc)
            return true;
        if (this.unusable)
            return false;
        try {
            let python = GLib.find_program_in_path("python3") || "python3";
            this.proc = Gio.Subprocess.new([python, this.helperPath],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            this.stdin = this.proc.get_stdin_pipe();
            this.stdout = new Gio.DataInputStream({ base_stream: this.proc.get_stdout_pipe() });
            this._readLine();
            return true;
        } catch (e) {
            warn("could not start GTK menu helper", e);
            this.unusable = true;
            return false;
        }
    }

    _readLine() {
        let stdout = this.stdout;
        if (!stdout)
            return;
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            let line = null;
            try {
                [line] = src.read_line_finish_utf8(res);
            } catch (e) {
                line = null;
            }
            if (line === null || line === undefined) {
                this._onExit();
                return;
            }
            this._handleLine(line);
            this._readLine();
        });
    }

    _handleLine(line) {
        if (!line.startsWith("{"))
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (msg.hello) {
            this.epoch = msg.epoch;
            return;
        }
        if (msg.epoch)
            this.epoch = msg.epoch;
        if (msg.fatal) {
            this.unusable = true;
            if (!this.reportedFatal) {
                this.reportedFatal = true;
                warn("GTK menu translation disabled: " + msg.fatal);
            }
            return;
        }
        let cb = this.pending.get(msg.req);
        if (cb) {
            this.pending.delete(msg.req);
            cb(msg, msg.error || null);
        }
    }

    _onExit() {
        this.epoch = 0;
        this.proc = null;
        this.stdin = null;
        this.stdout = null;
        for (let [req, cb] of Array.from(this.pending.entries())) {
            this.pending.delete(req);
            cb(null, "helper exited");
        }
    }

    request(cmd, args, timeoutMs, cb) {
        if (!this._start()) {
            if (cb)
                cb(null, "helper unavailable");
            return;
        }
        let req = this.nextReq++;
        let timer = 0;
        let done = false;
        let finish = (msg, err) => {
            if (done)
                return;
            done = true;
            if (timer)
                Mainloop.source_remove(timer);
            if (cb)
                cb(msg, err);
        };
        this.pending.set(req, finish);
        if (timeoutMs > 0) {
            timer = Mainloop.timeout_add(timeoutMs, () => {
                timer = 0;
                this.pending.delete(req);
                finish(null, "timeout");
                return false;
            });
        }
        try {
            let payload = Object.assign({ req: req, cmd: cmd }, args || {});
            this.stdin.write_all(ByteArray.fromString(JSON.stringify(payload) + "\n"), null);
        } catch (e) {
            this.pending.delete(req);
            finish(null, String(e));
        }
    }

    scan(pid, cb) {
        this.request("scan", { pid: pid }, 4000, cb);
    }

    activate(id) {
        this.request("do", { id: id, epoch: this.epoch }, 3000, (msg, err) => {
            if (err || (msg && msg.error))
                warn("could not activate GTK menu item", err || msg.error);
        });
    }

    closePopup() {
        this.request("close", {}, 2000, null);
    }

    destroy() {
        this.pending.clear();
        if (this.proc) {
            try {
                this.proc.force_exit();
            } catch (e) { /* ignore */ }
        }
        this.proc = null;
        this.stdin = null;
        this.stdout = null;
    }
}

/* ------------------------------------------------------------------------ */
/* Tray entries                                                             */
/* ------------------------------------------------------------------------ */

class TrayEntry {
    constructor(applet, kind, key) {
        this.applet = applet;
        this.kind = kind;
        this.key = key;
        this.destroyed = false;
        this.appInfo = null;
        this.pid = 0;
        this.gtkItems = null;
        this.lastEventTime = 0;

        this.iconName = null;
        this.iconSize = 0;

        /* Same actor structure as the stock XAppStatusIcon */
        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: true,
            track_hover: true,
            visible: false,
            // The systray uses a layout manager, we need to fill the space of the actor
            // or otherwise the menu will be displayed inside the panel.
            x_expand: true,
            y_expand: true
        });
        this.icon_holder = new St.Bin();
        this.label = new St.Label({ "y-align": St.Align.END });
        this.actor.add_actor(this.icon_holder);
        this.actor.add_actor(this.label);
        this.label.hide(); // only shown (by setLabel) for XApp icons that have a label

        this._tooltip = new Tooltips.PanelItemTooltip(this, "", applet.orientation);

        this.actor.connect("button-press-event", (a, ev) => this.onButtonPressEvent(a, ev));
        this.actor.connect("button-release-event", (a, ev) => this.onButtonReleaseEvent(a, ev));
        this.actor.connect("scroll-event", (a, ev) => this.onScrollEvent(a, ev));
        this.actor.connect("enter-event", () => this.onEnterEvent());

        /* Panel edit mode: Shift/Ctrl + drag reorders the icons (the drag is started by hand, see _onEditPress) */
        this.actor._delegate = this;
        this._draggable = null;
        try {
            let draggable;
            try {
                draggable = DND.makeDraggable(this.actor, { manualMode: true, restoreOnSuccess: false });
            } catch (e) {
                draggable = DND.makeDraggable(this.actor, { restoreOnSuccess: false });
            }
            draggable.inhibit = true;   // it never starts by itself, only through startDrag()
            draggable.connect("drag-begin", () => this.applet.dragBegan(this));
            draggable.connect("drag-end", () => this.applet.dragEnded(this));
            this._draggable = draggable;
        } catch (e) {
            warn("drag and drop is unavailable, icons can't be reordered", e);
        }

        this.setOrientation(applet.orientation);
    }

    /* Drag and drop: a small copy of the icon follows the pointer */
    getDragActor() {
        let icon = new St.Icon(this._iconParams || {
            "icon-name": "application-x-executable",
            "icon-size": this.applet.getPanelIconSize(St.IconType.FULLCOLOR)
        });
        icon.opacity = 220;
        return icon;
    }

    getDragActorSource() {
        return this.actor;
    }

    /* In panel edit mode only Shift/Ctrl + left button starts an icon drag; other presses move the applet itself */
    _onEditPress(event) {
        let mods = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK;
        if (this._draggable && event.get_button() === Clutter.BUTTON_PRIMARY && (event.get_state() & mods)) {
            let [x, y] = event.get_coords();
            try {
                /* Cinnamon's startDrag() takes the event itself (other versions: its timestamp) */
                try {
                    this._draggable.startDrag(x, y, event);
                } catch (e) {
                    this._draggable.startDrag(x, y, event.get_time());
                }
            } catch (e) {
                warn("could not start dragging " + this.displayName(), e);
            }
            return EVENT_STOP;
        }
        return EVENT_PROPAGATE;
    }

    /* ---- layout / icon (ported from xapp-status@cinnamon.org) ---- */
    setOrientation(orientation) {
        switch (orientation) {
            case St.Side.TOP:
            case St.Side.BOTTOM:
                this.actor.vertical = false;
                this.actor.remove_style_class_name("vertical");
                break;
            case St.Side.LEFT:
            case St.Side.RIGHT:
                this.actor.vertical = true;
                this.actor.add_style_class_name("vertical");
                break;
        }
    }

    onIconSize(size) { /* XApp entries tell the application */ }

    setIconName(iconName) {
        if (!iconName) {
            this.iconName = null;
            this.icon_holder.hide();
            return;
        }
        let type = iconName.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        this.iconName = iconName;
        this.iconSize = this.applet.getPanelIconSize(type);
        this.onIconSize(this.iconSize);

        let params = { "icon-type": type, "icon-size": this.iconSize };
        if (iconName.startsWith("/"))
            params.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(iconName) });
        else
            params["icon-name"] = iconName;
        this._iconParams = params;
        this.icon_holder.show();
        this.icon_holder.child = new St.Icon(params);
    }

    setTooltipText(tooltipText) {
        if (tooltipText) {
            this._tooltip.preventShow = false;
        } else {
            tooltipText = "";
            this._tooltip.preventShow = true;
        }
        this._tooltip.set_markup(tooltipText);

        // If the tooltip is currently visible, then we might need to trigger a realignment
        // of the tooltip after changing the text length
        if (this._tooltip.visible) {
            this._tooltip.hide();
            this._tooltip.show();
        }
    }

    setLabel(label) {
        this.label.set_text(label ? label : "");
        this.show_label = (this.applet.orientation == St.Side.TOP || this.applet.orientation == St.Side.BOTTOM) &&
            (label != null && label.length > 0);
        this.label.visible = this.show_label;
    }

    onEnterEvent() {
        if (this._tooltip)
            this._tooltip.preventShow = false;
    }

    /* Same coordinates / panel orientation the stock applet reports to apps */
    getEventPositionInfo() {
        let actor = this.actor;
        let allocation = Cinnamon.util_get_transformed_allocation(actor);

        let x = Math.round(allocation.x1 / global.ui_scale);
        let y = Math.round(allocation.y1 / global.ui_scale);
        let w = Math.round((allocation.x2 - allocation.x1) / global.ui_scale);
        let h = Math.round((allocation.y2 - allocation.y1) / global.ui_scale);

        let final_x, final_y, final_o;

        switch (this.applet.orientation) {
            case St.Side.TOP:
                final_x = x;
                final_y = y + h;
                final_o = Gtk.PositionType.TOP;
                break;
            case St.Side.BOTTOM:
            default:
                final_x = x;
                final_y = y;
                final_o = Gtk.PositionType.BOTTOM;
                break;
            case St.Side.LEFT:
                final_x = x + w;
                final_y = y;
                final_o = Gtk.PositionType.LEFT;
                break;
            case St.Side.RIGHT:
                final_x = x;
                final_y = y;
                final_o = Gtk.PositionType.RIGHT;
                break;
        }
        return [final_x, final_y, final_o];
    }

    /* ---- input ---- */
    /*
     * Like Cinnamon's own applets, clicks act on the button PRESS. If another menu is open, the menu manager
     * swallows that press (the click only closes the menu), so the matching release arrives here alone -
     * releases without a press of ours are therefore ignored.
     */
    onButtonPressEvent(actor, event) {
        if (this._tooltip) {
            this._tooltip.hide();
            this._tooltip.preventShow = true;
        }
        if (global.settings.get_boolean("panel-edit-mode"))
            return this._onEditPress(event);

        let button = event.get_button();
        if (button == Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return EVENT_PROPAGATE; // let the applet's own context menu open

        /* A click while a menu is open (or that has just closed one) only closes it */
        if (this.applet.consumeClickIfMenuOpen(event)) {
            this._pressedButton = 0;
            return EVENT_STOP;
        }

        this.lastEventTime = event.get_time();
        this._pressedButton = button;
        this._rawPressed = this.forwardsRaw(button);
        if (this._rawPressed)
            this.rawPress(event);
        else
            this.handleClick(button, event);
        return EVENT_STOP;
    }

    onButtonReleaseEvent(actor, event) {
        if (global.settings.get_boolean("panel-edit-mode"))
            return EVENT_PROPAGATE;
        let button = event.get_button();
        if (button == Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return EVENT_PROPAGATE;

        if (this._pressedButton !== button)
            return EVENT_STOP;   // the press went elsewhere (e.g. it closed a menu)
        this._pressedButton = 0;

        this.lastEventTime = event.get_time();
        if (this._rawPressed)
            this.rawRelease(event);
        this._rawPressed = false;
        this._runReleaseWaiters();
        return EVENT_STOP;
    }

    /*
     * Run fn once the mouse button of the current click has been released. Opening an application's own
     * popup while the button is still down makes GTK dismiss it on the real release, which made menu
     * reading fail at random.
     */
    whenReleased(fn) {
        if (!this._pressedButton) {
            fn();
            return;
        }
        let timer = 0;
        let done = false;
        let run = () => {
            if (done)
                return;
            done = true;
            if (timer) {
                Mainloop.source_remove(timer);
                timer = 0;
            }
            if (!this.destroyed)
                fn();
        };
        timer = Mainloop.timeout_add(1000, () => {
            timer = 0;
            run();
            return false;
        });
        if (!this._releaseWaiters)
            this._releaseWaiters = [];
        this._releaseWaiters.push(run);
    }

    _runReleaseWaiters() {
        let waiters = this._releaseWaiters || [];
        this._releaseWaiters = [];
        for (let run of waiters)
            run();
    }

    onScrollEvent(actor, event) {
        if (global.settings.get_boolean("panel-edit-mode"))
            return EVENT_PROPAGATE;
        let direction = event.get_scroll_direction();
        if (direction != Clutter.ScrollDirection.SMOOTH)
            this.scroll(direction, event);
        return EVENT_STOP;
    }

    handleClick(button, event) {
        if (button === Clutter.BUTTON_PRIMARY) {
            if (this.applet.leftClickAction === "activate" && this.canActivate())
                this.activate();
            else
                this.applet.toggleMenuFor(this);
        } else if (button === Clutter.BUTTON_SECONDARY) {
            if (this.applet.rightClickNative && !this.hasCapturedMenu() && this.hasNativeMenu() &&
                !this.canTranslateNative())
                this.showNativeMenu();
            else
                this.applet.toggleMenuFor(this);
        } else if (button === Clutter.BUTTON_MIDDLE) {
            this.secondaryActivate();
        }
    }

    /* ---- helpers ---- */
    resolveProcess(busName, cb) {
        getBusPid(busName, (pid) => {
            if (this.destroyed)
                return;
            this.pid = pid;
            if (pid)
                this.appInfo = resolveApp(pid);
            this.processResolved = true;
            if (cb)
                cb(pid);
        });
    }

    displayName() {
        let name = "";
        if (this.appInfo && this.appInfo.name)
            name = this.appInfo.name;
        else
            name = prettyName(this.fallbackName());
        return titleCase(name ? name : _("application"));
    }

    addOpenItem(menu, callback) {
        let icon = null;
        if (this.appInfo && this.appInfo.gicon) {
            icon = new St.Icon({
                gicon: this.appInfo.gicon,
                icon_size: MENU_ICON_SIZE,
                icon_type: St.IconType.FULLCOLOR
            });
        }
        let item = makeMenuItem(_("Open %s").replace("%s", this.displayName()), icon);
        item.connect("activate", callback);
        menu.addMenuItem(item);
        return !!icon;
    }

    updateVisibility() {
        this.actor.visible = !this.destroyed && this.computeVisible() && !this.applet.isUserHidden(this);
    }

    /* Stable identifier used to remember things about this icon between sessions */
    stableId() { return ""; }

    /* Identifies the icon in the saved icon order */
    orderKey() {
        return (this.kind + ":" + (this.stableId() || this.sortName())).toLowerCase();
    }

    wmClasses() {
        let out = [];
        if (this.appInfo) {
            if (this.appInfo.id) {
                out.push(this.appInfo.id);
                out.push(this.appInfo.id.split(".").pop());
            }
            if (this.appInfo.wmClass)
                out.push(this.appInfo.wmClass);
        }
        return out;
    }

    windowMatches(win) {
        if (!win)
            return false;
        try {
            if (this.pid && win.get_pid() === this.pid)
                return true;
        } catch (e) { /* ignore */ }
        try {
            let mine = this.wmClasses();
            let cls = [win.get_wm_class(), win.get_wm_class_instance()].filter(c => !!c).map(c => c.toLowerCase());
            return cls.some(c => mine.indexOf(c) >= 0);
        } catch (e) {
            return false;
        }
    }

    hasWindow() {
        try {
            return global.get_window_actors().some(a => this.windowMatches(a.meta_window));
        } catch (e) {
            return true; // unknown: be safe
        }
    }

    /* True if the "Open ..." entry should not be offered for this icon */
    openSuppressed() {
        return this.applet.isOpenSuppressed(this);
    }

    canTranslateNative() {
        return !!(this.pid > 0 && this.applet.gtkBridge.usable());
    }

    /*
     * Ask the application to open its own menu, read it through AT-SPI and keep the result in this.gtkItems.
     * cb(true): captured, or the application has no menu; cb(false): a popup exists but could not be read
     * (then it is left visible so the user simply gets the application's own menu).
     * opts.button: remember the result in the menu cache; opts.background: never reveal the native popup.
     * If the popup only shows up after the first-pass probe, the open menu is updated when it is read.
     */
    scanNative(trigger, cb, opts) {
        opts = opts || {};
        let applet = this.applet;
        if (!opts.background)
            this.gtkItems = null;
        let hider = applet.hidePopupsFor(this.pid);
        let state = "wait";   // wait | nomenu | done
        let probeTimer = 0;
        let finish = (ok) => {
            let f = cb;
            cb = null;
            if (f)
                f(ok);
        };

        probeTimer = Mainloop.timeout_add(1200, () => {
            probeTimer = 0;
            if (state === "wait" && hider.count() === 0) {
                state = "nomenu";
                if (opts.onNoPopup)
                    opts.onNoPopup();
                finish(true);
            }
            return false;
        });

        try {
            trigger();
        } catch (e) {
            warn("could not open native menu", e);
        }

        applet.gtkBridge.scan(this.pid, (res, err) => {
            if (probeTimer) {
                Mainloop.source_remove(probeTimer);
                probeTimer = 0;
            }
            let late = state === "nomenu";
            state = "done";
            let ok = !!(res && res.items && res.items.length > 0);
            if (this.destroyed) {
                if (ok)
                    applet.gtkBridge.closePopup();
                else
                    hider.reveal();
                return;
            }
            if (ok) {
                if (opts.button)
                    applet.storeMenu(this.stableId(), opts.button, res.items, res.epoch);
                applet.gtkBridge.closePopup();
                Mainloop.timeout_add(150, () => {
                    hider.stop();
                    if (!opts.background) {
                        this.gtkItems = res.items;
                        this.gtkEpoch = res.epoch;
                    }
                    if (late)
                        applet.menuContentChanged(this);
                    else
                        finish(true);
                    return false;
                });
            } else if (late) {
                hider.stop();   // there really was no popup
            } else if (opts.background) {
                if (hider.count() > 0)
                    applet.gtkBridge.closePopup();
                Mainloop.timeout_add(300, () => {
                    hider.stop();
                    finish(true);
                    return false;
                });
            } else {
                warn("could not read the native menu of " + this.displayName() + ": " + (err || "no items"));
                hider.reveal();
                finish(false);
            }
        });
    }

    /* Open the application's own menu (used to read or activate it); subclasses know how */
    triggerNativeMenu() { /* subclass */ }

    /* Activate an item of a translated GTK menu: directly if its node is still valid, else via a fresh read */
    activateGtkItem(gtkId, path) {
        let bridge = this.applet.gtkBridge;
        let fresh = gtkId && this.gtkEpoch && this.gtkEpoch === bridge.epoch;
        let viaPath = () => this.rescanAndActivate(path);
        if (!fresh) {
            viaPath();
            return;
        }
        bridge.request("do", { id: gtkId, epoch: this.gtkEpoch }, 3000, (msg, err) => {
            if (err || !msg || !msg.ok)
                viaPath();
        });
    }

    rescanAndActivate(path) {
        let button = typeof this.nativeButton === "function" ? this.nativeButton() : 3;
        this.scanNative(() => this.triggerNativeMenu(), () => {
            if (!this.gtkItems)
                return;
            let id = findItemByPath(this.gtkItems, path);
            if (id)
                this.applet.gtkBridge.activate(id);
            else
                warn("menu item '" + path.join(" > ") + "' no longer exists in " + this.displayName());
        }, { button: button });
    }

    /* ---- overridable ---- */
    fallbackName() { return ""; }
    matchNames() { return [this.appInfo ? this.appInfo.name : ""]; }
    sortName() { return this.displayName().toLowerCase(); }
    computeVisible() { return true; }
    refresh() { /* subclass */ }
    forwardsRaw(button) { return false; }
    rawPress(event) { /* subclass */ }
    rawRelease(event) { /* subclass */ }
    canActivate() { return true; }
    hasCapturedMenu() { return true; }
    hasNativeMenu() { return false; }
    showNativeMenu() { /* subclass */ }
    activate() { /* subclass */ }
    secondaryActivate() { /* subclass */ }
    scroll(direction, event) { /* subclass */ }
    prepareMenu(cb) { cb(true); }
    fillMenu(menu) { /* subclass */ }

    destroy() {
        this.destroyed = true;
        this._tooltip.destroy();
        this._tooltip = null;
        this.actor.destroy();
    }
}

/* ---- StatusNotifierItem ------------------------------------------------- */

class SniEntry extends TrayEntry {
    /* Different ways of writing the same item ("name", "name/path", ...) must give the same key */
    static normalize(registered) {
        let slash = registered.indexOf("/");
        let busName = slash < 0 ? registered : registered.substring(0, slash);
        let objPath = slash < 0 ? "/StatusNotifierItem" : registered.substring(slash);
        return { busName: busName, objPath: objPath, key: "sni:" + busName + objPath };
    }

    constructor(applet, registered) {
        let n = SniEntry.normalize(registered);
        super(applet, "sni", n.key);
        this.busName = n.busName;
        this.objPath = n.objPath;

        this.props = {};
        this.menuClient = null;
        this.subIds = [];
        this.refreshTimer = 0;
        this.pixmapPath = null;
        this.pixmapKey = "";

        let bus = Gio.DBus.session;
        let onSignal = () => this._scheduleRefresh();
        this.subIds.push(bus.signal_subscribe(this.busName, SNI_IFACE, null, this.objPath, null,
            Gio.DBusSignalFlags.NONE, onSignal));
        this.subIds.push(bus.signal_subscribe(this.busName, PROPS_IFACE, "PropertiesChanged", this.objPath, null,
            Gio.DBusSignalFlags.NONE, onSignal));

        this.watchId = Gio.bus_watch_name(Gio.BusType.SESSION, this.busName, Gio.BusNameWatcherFlags.NONE,
            () => { /* appeared */ },
            () => this.applet.removeEntry(this.key));

        this.hasActivate = true;
        this.resolveProcess(this.busName, () => this.refresh());
        this._fetchProps();
        this._introspect();
    }

    /* Items that don't implement Activate can't "open" anything */
    _introspect() {
        sessionCall(this.busName, this.objPath, "org.freedesktop.DBus.Introspectable", "Introspect", null, "(s)",
            (res) => {
                if (!res || this.destroyed)
                    return;
                try {
                    let xml = res.deepUnpack()[0];
                    if (xml.indexOf('<interface name="org.kde.StatusNotifierItem"') >= 0 &&
                        xml.indexOf('name="Activate"') < 0)
                        this.hasActivate = false;
                } catch (e) { /* ignore */ }
            });
    }

    stableId() {
        return String(this.props.Id || "").toLowerCase();
    }

    _scheduleRefresh() {
        if (this.destroyed || this.refreshTimer)
            return;
        this.refreshTimer = Mainloop.timeout_add(60, () => {
            this.refreshTimer = 0;
            this._fetchProps();
            return false;
        });
    }

    _fetchProps() {
        sessionCall(this.busName, this.objPath, PROPS_IFACE, "GetAll",
            new GLib.Variant("(s)", [SNI_IFACE]), "(a{sv})", (res, err) => {
                if (this.destroyed)
                    return;
                if (!res) {
                    /* Freshly started applications often register before they export their properties: retry */
                    this._propRetries = (this._propRetries || 0) + 1;
                    if (this._propRetries <= 8 && Object.keys(this.props).length === 0) {
                        if (this._retryTimer)
                            Mainloop.source_remove(this._retryTimer);
                        this._retryTimer = Mainloop.timeout_add(400 * this._propRetries, () => {
                            this._retryTimer = 0;
                            if (!this.destroyed)
                                this._fetchProps();
                            return false;
                        });
                    } else {
                        warn("could not read properties of " + this.busName, err);
                    }
                    return;
                }
                this._propRetries = 0;
                try {
                    this.props = res.recursiveUnpack()[0] || {};
                } catch (e) {
                    warn("bad properties from " + this.busName, e);
                    return;
                }
                this.refresh();
            });
    }

    refresh() {
        if (this.destroyed)
            return;
        if (!this.appInfo && !this._hintTried && this.processResolved && Object.keys(this.props).length > 0) {
            this._hintTried = true;
            this.appInfo = resolveAppByHint([this.props.Id, this.props.Title]);
        }
        this.updateVisibility();
        this._applyIcon();
        this._applyTooltip();
        this.setOrientation(this.applet.orientation);
        this.actor.queue_relayout();
        if (!this._sorted && Object.keys(this.props).length > 0) {
            this._sorted = true;
            this.applet.sortEntries();
        }
        this.applet.dedupeSni(this);
    }

    _applyIcon() {
        let p = this.props;
        if (Object.keys(p).length === 0)
            return;
        let attention = p.Status === "NeedsAttention";
        let name = (attention && p.AttentionIconName) ? p.AttentionIconName : p.IconName;
        let pix = (attention && p.AttentionIconPixmap && p.AttentionIconPixmap.length > 0)
            ? p.AttentionIconPixmap : p.IconPixmap;

        let iconName = null;
        if (name) {
            name = String(name);
            if (!name.startsWith("/") && p.IconThemePath) {
                addThemePath(p.IconThemePath);
                for (let ext of [".svg", ".png", ".xpm"]) {
                    let candidate = GLib.build_filenamev([p.IconThemePath, name + ext]);
                    if (GLib.file_test(candidate, GLib.FileTest.EXISTS)) {
                        name = candidate;
                        break;
                    }
                }
            }
            iconName = name;
        } else if (pix && pix.length > 0) {
            /* Like xapp-sn-watcher: hand pixmaps over as an image file */
            let best = pickPixmap(pix, 64 * global.ui_scale);
            let key = best ? best[0] + "x" + best[1] + ":" + hashBytes(best[2]) : "";
            if (key !== this.pixmapKey || !this.pixmapPath) {
                let path = savePixmapFile(pix, 64 * global.ui_scale, this.busName, this.pixmapPath);
                if (path) {
                    this.pixmapPath = path;
                    this.pixmapKey = key;
                }
            }
            iconName = this.pixmapPath;
        }
        this.setIconName(iconName || "application-x-executable");
    }

    _applyTooltip() {
        let p = this.props;
        let tt = p.ToolTip;
        let title = (tt && tt[2]) || p.Title || p.Id || "";
        let text = ((tt && tt[3]) || "").replace(/<[^>]*>/g, "");
        let full = text ? title + "\n" + text : title;
        this.setTooltipText(GLib.markup_escape_text(full, -1));
    }

    fallbackName() {
        return this.props.Title || this.props.Id || "";
    }

    matchNames() {
        return [this.appInfo ? this.appInfo.name : "", this.props.Title, this.props.Id, this.props.IconName];
    }

    sortName() {
        return String(this.props.Id || this.props.Title || this.busName).toLowerCase();
    }

    computeVisible() {
        if (Object.keys(this.props).length === 0)
            return false;
        if (this.props.Status === "Passive")
            return false;
        return true;
    }

    hasDbusMenu() {
        let m = this.props.Menu;
        return typeof m === "string" && m.length > 1 && m !== "/NO_DBUSMENU";
    }

    _callPoint(method) {
        let [x, y] = this.getEventPositionInfo();
        sessionCall(this.busName, this.objPath, SNI_IFACE, method, new GLib.Variant("(ii)", [x, y]), null,
            (res, err) => {
                if (err)
                    warn(method + " failed on " + this.busName, err);
            });
    }

    canActivate() { return !this.props.ItemIsMenu && this.hasActivate; }
    hasCapturedMenu() { return this.hasDbusMenu(); }
    hasNativeMenu() { return true; }
    showNativeMenu() { this._callPoint("ContextMenu"); }
    triggerNativeMenu() { this._callPoint("ContextMenu"); }
    activate() {
        if (this.props.ItemIsMenu)
            this._callPoint("ContextMenu");
        else
            this.applet.runOpen(this, () => this._callPoint("Activate"));
    }
    secondaryActivate() { this._callPoint("SecondaryActivate"); }

    scroll(dir) {
        let vertical = dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.DOWN;
        let positive = dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT;
        sessionCall(this.busName, this.objPath, SNI_IFACE, "Scroll",
            new GLib.Variant("(is)", [positive ? 120 : -120, vertical ? "vertical" : "horizontal"]), null,
            () => { /* ignore */ });
    }

    prepareMenu(cb) {
        this.gtkItems = null;
        if (this.hasDbusMenu()) {
            if (!this.menuClient) {
                this.menuClient = new DBusMenuClient(this.busName, this.props.Menu,
                    () => this.applet.menuLayoutChanged(this));
            }
            this.menuClient.prepare(() => cb(true));
        } else if (this.canTranslateNative()) {
            this.whenReleased(() => this.scanNative(() => this._callPoint("ContextMenu"), cb));
        } else {
            cb(true);
        }
    }

    fillMenu(menu) {
        let client = this.menuClient;
        let source = null;
        if (this.hasDbusMenu() && client && client.hasItems())
            source = client;
        else if (this.gtkItems)
            source = new GtkMenuSource(this.gtkItems, this);
        let hasItems = !!source;
        let name = this.displayName();
        let isMenuOnly = !!this.props.ItemIsMenu;

        /* "Open <app>" is only added in "Show the menu" mode; never if the menu already has such an entry */
        let wantOpen = this.applet.showOpenEntry && !isMenuOnly && this.hasActivate && !this.openSuppressed();
        if (wantOpen && hasItems && source.hasOpenLikeItem(name))
            wantOpen = false;

        let reserve = false;
        if (wantOpen)
            reserve = this.addOpenItem(menu, () => this.activate());

        if (this.hasDbusMenu() && !hasItems)
            warn("dbusmenu " + this.props.Menu + " of " + this.busName + " returned no visible items");

        if (hasItems) {
            if (wantOpen)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            source.populate(menu, reserve);
        } else if (isMenuOnly || !wantOpen) {
            /* No dbusmenu: ask the application to show its own context menu. */
            let item = makeMenuItem(_("Show application menu"), null);
            item.connect("activate", () => {
                Mainloop.timeout_add(150, () => {
                    this._callPoint("ContextMenu");
                    return false;
                });
            });
            menu.addMenuItem(item);
        }
    }

    destroy() {
        if (this._retryTimer) {
            Mainloop.source_remove(this._retryTimer);
            this._retryTimer = 0;
        }
        if (this.refreshTimer) {
            Mainloop.source_remove(this.refreshTimer);
            this.refreshTimer = 0;
        }
        for (let id of this.subIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this.subIds = [];
        if (this.watchId) {
            Gio.bus_unwatch_name(this.watchId);
            this.watchId = 0;
        }
        if (this.menuClient) {
            this.menuClient.destroy();
            this.menuClient = null;
        }
        if (this.pixmapPath) {
            try {
                Gio.File.new_for_path(this.pixmapPath).delete(null);
            } catch (e) { /* ignore */ }
            this.pixmapPath = null;
        }
        super.destroy();
    }
}

/* ---- XApp status icon (logic ported from xapp-status@cinnamon.org) ------ */

class XAppEntry extends TrayEntry {
    constructor(applet, proxy) {
        super(applet, "xapp", XAppEntry.keyFor(proxy));
        this.proxy = proxy;
        this.pending = true;

        this.primaryIsMenu = this.applet.isLearned(this.stableId() + "#menu2");   // learned: a left click opens a menu, not a window
        this.lastButton = 3;
        this.proxy.icon_size = this.applet.getPanelIconSize(St.IconType.FULLCOLOR);
        this._proxy_prop_change_id = this.proxy.connect("g-properties-changed",
            (p, changed, invalidated) => this.on_properties_changed(p, changed, invalidated));

        let owner = proxy.get_name_owner() || proxy.get_name();
        this.resolveProcess(owner, (pid) => {
            this.pending = false;
            let cmd = pid ? readCmdline(pid).join(" ") : "";
            if (cmd.indexOf("xapp-sn-watcher") >= 0) {
                /* Mirror of a StatusNotifier item: the SNI entry covers it. */
                this.applet.removeEntry(this.key);
                this.applet.syncSniSoon();
                return;
            }
            this.refresh();
        });

        this.refresh();

        /* Safety net: never stay hidden because the process lookup was slow */
        this._pendingTimer = Mainloop.timeout_add(2500, () => {
            this._pendingTimer = 0;
            if (!this.destroyed && this.pending) {
                this.pending = false;
                this.refresh();
            }
            return false;
        });
    }

    static keyFor(proxy) {
        return "xapp:" + proxy.get_name() + proxy.get_object_path();
    }

    stableId() {
        return String(this.proxy.name || "").toLowerCase();
    }

    onIconSize(size) {
        this.proxy.icon_size = size;
    }

    on_properties_changed(proxy, changed_props, invalidated_props) {
        let prop_names = changed_props.deep_unpack();

        if ("IconName" in prop_names)
            this.setIconName(proxy.icon_name);
        if ("TooltipText" in prop_names)
            this.setTooltipText(proxy.tooltip_text);
        if ("Label" in prop_names)
            this.setLabel(proxy.label);
        if ("Visible" in prop_names)
            this.updateVisibility();
        if ("Name" in prop_names)
            this.applet.sortEntries();
        if ("PrimaryMenuIsOpen" in prop_names) {
            if (!proxy.primary_menu_is_open)
                this.actor.sync_hover();
        }
        if ("SecondaryMenuIsOpen" in prop_names) {
            if (!proxy.secondary_menu_is_open)
                this.actor.sync_hover();
        }
    }

    refresh() {
        if (this.destroyed)
            return;
        this.setIconName(this.proxy.icon_name);
        this.setLabel(this.proxy.label);
        this.setTooltipText(this.proxy.tooltip_text);
        this.updateVisibility();
        this.setOrientation(this.applet.orientation);
        this.actor.queue_relayout();
    }

    computeVisible() {
        if (this.pending || !this.proxy.visible)
            return false;
        /* Hide icons for which Cinnamon has a dedicated applet (as the stock applet does) */
        try {
            let roles = Main.systrayManager.getRoles();
            let name = (this.proxy.name || "").toLowerCase();
            if (roles.indexOf(name) != -1)
                return false;
        } catch (e) { /* no systray manager */ }
        return true;
    }

    fallbackName() {
        return this.proxy.name || this.proxy.label || "";
    }

    matchNames() {
        return [this.appInfo ? this.appInfo.name : "", this.proxy.name, this.proxy.icon_name, this.proxy.label];
    }

    sortName() {
        return String(this.proxy.name || "").replace("org.x.StatusIcon.", "").toLowerCase();
    }

    /* ---- clicks: forwarded 1:1 like the stock applet when we don't re-render a menu ---- */
    forwardsRaw(button) {
        if (button === Clutter.BUTTON_MIDDLE)
            return true;
        if (button === Clutter.BUTTON_PRIMARY)
            return this.applet.leftClickAction === "activate" && this.canActivate() && !this.canTranslateNative();
        if (button === Clutter.BUTTON_SECONDARY)
            return this.applet.rightClickNative && !this.canTranslateNative();
        return false;
    }

    handleClick(button, event) {
        this.lastButton = button;
        if (button === Clutter.BUTTON_PRIMARY && this.applet.leftClickAction === "activate" &&
            this.canTranslateNative()) {
            this.whenReleased(() => this.primaryClick(this.lastEventTime));
            return;
        }
        super.handleClick(button, event);
    }

    /*
     * Click the icon like the stock applet would. If the application answers with a popup menu (instead
     * of opening a window), read that menu and show it as a panel menu.
     */
    primaryClick(time) {
        let applet = this.applet;
        if (!this.canTranslateNative()) {
            this.synthClick(1, time);
            return;
        }
        let hider = applet.hidePopupsFor(this.pid);
        this.synthClick(1, time);
        let tries = 0;
        Mainloop.timeout_add(100, () => {
            if (this.destroyed) {
                hider.stop();
                return false;
            }
            if (hider.count() > 0) {
                this._sawPopup = true;   // something popped up, so the click did have an effect
                applet.gtkBridge.scan(this.pid, (res, err) => {
                    if (this.destroyed) {
                        hider.reveal();
                        return;
                    }
                    if (res && res.items && res.items.length > 0) {
                        /* Only now is it certain that a left click shows a menu */
                        this.primaryIsMenu = true;
                        this.lastButton = 1;
                        applet.markLearned(this.stableId() + "#menu2");
                        this.gtkItems = res.items;
                        this.gtkEpoch = res.epoch;
                        applet.storeMenu(this.stableId(), 1, res.items, res.epoch);
                        applet.gtkBridge.closePopup();
                        Mainloop.timeout_add(150, () => {
                            hider.stop();
                            applet.openMenuNow(this);
                            return false;
                        });
                    } else {
                        warn("could not read the menu of " + this.displayName() + ": " + (err || "no items"));
                        hider.reveal();
                    }
                });
                return false;
            }
            if (++tries >= 6) {
                hider.stop();   // no popup: the click did something else (e.g. opened a window)
                return false;
            }
            return true;
        });
    }

    rawPress(event) {
        let [x, y, o] = this.getEventPositionInfo();
        this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), o, null, null);
    }

    rawRelease(event) {
        let [x, y, o] = this.getEventPositionInfo();
        this.proxy.call_button_release(x, y, event.get_button(), event.get_time(), o, null, null);
    }

    scroll(direction, event) {
        let x_dir = XApp.ScrollDirection.UP;
        let delta = 0;

        if (direction == Clutter.ScrollDirection.UP) {
            x_dir = XApp.ScrollDirection.UP;
            delta = -1;
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            x_dir = XApp.ScrollDirection.DOWN;
            delta = 1;
        } else if (direction == Clutter.ScrollDirection.LEFT) {
            x_dir = XApp.ScrollDirection.LEFT;
            delta = -1;
        } else if (direction == Clutter.ScrollDirection.RIGHT) {
            x_dir = XApp.ScrollDirection.RIGHT;
            delta = 1;
        }
        this.proxy.call_scroll(delta, x_dir, event.get_time(), null, null);
    }

    /* A click we synthesize (from the "Open ..." menu entry) */
    synthClick(button, time) {
        let [x, y, o] = this.getEventPositionInfo();
        let t = time || global.get_current_time();
        this.proxy.call_button_press(x, y, button, t, o, null, null);
        Mainloop.timeout_add(60, () => {
            if (!this.destroyed)
                this.proxy.call_button_release(x, y, button, t, o, null, null);
            return false;
        });
    }

    /*
     * Installed libxapp versions differ: this one does not publish
     * PrimaryMenuIsValid / SecondaryMenuIsValid, so we can't tell whether the
     * application has a right-click menu. Assume it may (right click = button 3)
     * and let the scan find out.
     */
    canActivate() { return true; }
    hasCapturedMenu() { return false; }
    hasNativeMenu() { return true; }
    activate() { this.primaryClick(); }

    nativeButton() {
        return (this.primaryIsMenu && this.lastButton === 1) ? 1 : 3;
    }

    /* If a "left click shows a menu" assumption proves wrong (no popup appeared), forget it */
    _noPopupHandler(button) {
        if (button !== 1)
            return null;
        return () => this.unlearnPrimaryMenu();
    }

    unlearnPrimaryMenu() {
        if (!this.primaryIsMenu)
            return;
        this.primaryIsMenu = false;
        this.lastButton = 3;
        this.applet.forgetLearned(this.stableId() + "#menu2");
        delete this.applet.menuCache[this.stableId() + "|1"];
        this.applet.menuContentChanged(this);   // brings the "Open ..." entry back if the menu is showing
    }

    triggerNativeMenu() {
        this.synthClick(this.nativeButton());
    }

    /*
     * Show the stored copy of the menu immediately (it is refreshed in the background after the menu
     * closes); read it for real only the very first time.
     */
    prepareMenu(cb) {
        this.gtkItems = null;
        if (!this.canTranslateNative()) {
            cb(true);
            return;
        }
        let button = this.nativeButton();
        let cached = this.applet.cachedMenu(this.stableId(), button);
        if (cached) {
            this.gtkItems = cached.items;
            this.gtkEpoch = cached.epoch;
            cb(true);
            return;
        }
        this.whenReleased(() => {
            this.scanNative(() => this.synthClick(button, this.lastEventTime), cb,
                { button: button, onNoPopup: this._noPopupHandler(button) });
        });
    }

    /* Called when a menu of this entry was closed: update the stored copy for the next opening */
    scheduleRefresh(retries) {
        if (this.destroyed || !this.canTranslateNative() || this._refreshTimer)
            return;
        this._refreshTimer = Mainloop.timeout_add(500, () => {
            this._refreshTimer = 0;
            this.refreshNative(retries || 0);
            return false;
        });
    }

    refreshNative(retries) {
        if (this.destroyed || !this.canTranslateNative())
            return;
        let applet = this.applet;
        if (applet.menu.isOpen || applet.pointerButtonsDown() || applet._scanBusy) {
            if (retries < 8)
                this.scheduleRefresh(retries + 1);
            return;
        }
        /* Never "click" the icon's primary action in the background unless its menu was read that way before */
        let button = (this.primaryIsMenu && this.lastButton === 1 && applet.cachedMenu(this.stableId(), 1)) ? 1 : 3;
        applet._scanBusy = true;
        let watchdog = Mainloop.timeout_add(6000, () => {
            watchdog = 0;
            applet._scanBusy = false;
            return false;
        });
        this.scanNative(() => this.synthClick(button), () => {
            if (watchdog) {
                Mainloop.source_remove(watchdog);
                watchdog = 0;
            }
            applet._scanBusy = false;
        }, { button: button, background: true, onNoPopup: this._noPopupHandler(button) });
    }

    fillMenu(menu) {
        /* No "Open ..." entry for applications whose left click shows a menu instead of a window */
        let reserve = false;
        let added = false;
        if (this.applet.showOpenEntry && !this.primaryIsMenu && !this.openSuppressed()) {
            reserve = this.addOpenItem(menu, () => {
                let t = Clutter.get_current_event_time();
                this._sawPopup = false;
                this.applet.runOpen(this, () => this.primaryClick(t), () => this._sawPopup);
            });
            added = true;
        }

        if (this.gtkItems) {
            let source = new GtkMenuSource(this.gtkItems, this);
            if (added)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            source.populate(menu, reserve);
        } else if (!this.canTranslateNative()) {
            /* Translation unavailable: let the application show its own menu. */
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let item = makeMenuItem(_("Show application menu"), null);
            item.connect("activate", () => {
                Mainloop.timeout_add(150, () => {
                    if (!this.destroyed)
                        this.synthClick(3);
                    return false;
                });
            });
            menu.addMenuItem(item);
        }
    }

    destroy() {
        if (this._refreshTimer) {
            Mainloop.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        if (this._pendingTimer) {
            Mainloop.source_remove(this._pendingTimer);
            this._pendingTimer = 0;
        }
        try {
            this.proxy.disconnect(this._proxy_prop_change_id);
        } catch (e) { /* ignore */ }
        this._proxy_prop_change_id = 0;
        super.destroy();
    }
}

/* ---- Legacy XEmbed icon ------------------------------------------------- */

let _legacyCounter = 0;

class EmbeddedEntry extends TrayEntry {
    constructor(applet, trayIcon, role) {
        super(applet, "xembed", "xembed:" + (++_legacyCounter));
        this.trayIcon = trayIcon;
        this.role = role || trayIcon.wm_class || "";
        this._eventId = 0;

        let pid = 0;
        let title = "";
        try {
            pid = trayIcon.pid || 0;
            title = trayIcon.title || "";
        } catch (e) { /* ignore */ }
        if (pid) {
            this.pid = pid;
            this.appInfo = resolveApp(pid);
            this.processResolved = true;
        }

        /* Same set-up as the stock System Tray applet: centred, filled vertically, and only shown and made
         * clickable after a short delay (the embedded window reports a bogus size when it first docks). */
        trayIcon.set_x_align(Clutter.ActorAlign.CENTER);
        trayIcon.set_y_align(Clutter.ActorAlign.FILL);
        this.actor.set_y_align(Clutter.ActorAlign.FILL);
        this.icon_holder.set_child(trayIcon);
        this.label.hide();
        trayIcon.visible = false;
        trayIcon.opacity = 0;
        this.updateVisibility();
        this.setTooltipText(GLib.markup_escape_text(this.appInfo ? this.appInfo.name : (title || this.role), -1));

        this._activateTimer = Mainloop.timeout_add(1000, () => {
            this._activateTimer = 0;
            this._activateIcon();
            return false;
        });

        /* When another applet (e.g. Drawer) hides and re-shows us, the embedded window must be mapped again */
        this._mappedId = this.actor.connect("notify::mapped", () => {
            if (this.actor.mapped)
                this._remap();
        });
        /* The application draws its own tooltip: once seen, the panel's name tooltip is no longer shown */
        this._mapId = global.window_manager.connect("map", (wm, actor) => this._onWindowMapped(actor));
        this._destroyId = trayIcon.connect("destroy", () => {
            if (!this.destroyed)
                this.applet.removeEntry(this.key);
        });
    }

    _remap() {
        if (this._remapTimer)
            return;
        this._remapTimer = Mainloop.timeout_add(150, () => {
            this._remapTimer = 0;
            if (!this.destroyed && this._eventId) {
                this.trayIcon.hide();
                this.trayIcon.show();
                this.trayIcon.opacity = 255;
                this.resize();
            }
            return false;
        });
    }

    /*
     * A popup of the application that appears while the pointer rests on the icon (and not after a click, which
     * would be its menu) is the application's own tooltip. Its text can't be read (such windows are not exposed
     * through AT-SPI), so it can't be restyled; the panel's name tooltip steps aside and the application's
     * tooltip, which describes what the icon is notifying, is shown on its own.
     */
    _onWindowMapped(actor) {
        let win = actor.meta_window;
        if (!this._hovered || !this.pid || !win || win.get_pid() !== this.pid || !win.is_override_redirect() ||
            GLib.get_monotonic_time() - (this._lastPressAt || 0) < 2e6)
            return;
        this._appTooltip = true;
        this._tooltip.hide();
        this._tooltip.preventShow = true;
        global.window_manager.disconnect(this._mapId);
        this._mapId = 0;
    }

    onEnterEvent() {
        if (!this._appTooltip)
            super.onEnterEvent();
    }

    _activateIcon() {
        if (this.destroyed)
            return;
        try {
            if (typeof this.trayIcon.is_finalized === "function" && this.trayIcon.is_finalized())
                return;
            this.trayIcon.reactive = true;
            this.trayIcon.visible = true;
            this.resize();
            if (typeof this.trayIcon.ease === "function") {
                this.trayIcon.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            } else {
                this.trayIcon.opacity = 255;
            }
            this._eventId = this.trayIcon.connect("event", (actor, event) => this._onTrayEvent(actor, event));
        } catch (e) {
            warn("could not activate legacy tray icon " + this.role, e);
        }
    }

    /*
     * Legacy icons are real windows of the application. Cinnamon hands every event on the icon to
     * icon.handle_event(), which passes it on to that window (this is what the stock applet does).
     */
    _onTrayEvent(icon, event) {
        if (global.settings.get_boolean("panel-edit-mode"))
            return false;   // editing the panel: nothing goes to the application
        let etype = event.type();

        /* Ctrl+right click belongs to the applet's own context menu */
        if ((etype === Clutter.EventType.BUTTON_PRESS || etype === Clutter.EventType.BUTTON_RELEASE) &&
            event.get_button() === Clutter.BUTTON_SECONDARY &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return false;

        if (etype === Clutter.EventType.BUTTON_PRESS) {
            this._lastPressAt = GLib.get_monotonic_time();
        } else if (etype === Clutter.EventType.ENTER) {
            this._hovered = true;
            this.actor.add_style_pseudo_class("hover");
        } else if (etype === Clutter.EventType.LEAVE) {
            this._hovered = false;
            this.actor.remove_style_pseudo_class("hover");
        }

        try {
            return icon.handle_event(etype, event);
        } catch (e) {
            warn("could not pass an event on to the legacy tray icon " + this.role, e);
            return false;
        }
    }

    /* Same sizing as systray@cinnamon.org */
    resize() {
        let size = this.applet.getPanelIconSize(St.IconType.FULLCOLOR) * global.ui_scale;
        this.trayIcon.set_size(size, size);
    }

    refresh() {
        this.resize();
        this.setOrientation(this.applet.orientation);
    }

    matchNames() { return [this.role]; }
    fallbackName() { return this.role; }
    sortName() { return String(this.role).toLowerCase(); }
    computeVisible() { return true; }

    /* The icon handles its own clicks (see _onTrayEvent); the wrapper must not act on them */
    forwardsRaw(button) { return true; }
    rawPress(event) { /* handled by _onTrayEvent */ }
    rawRelease(event) { /* handled by _onTrayEvent */ }

    destroy() {
        this.destroyed = true;
        for (let t of ["_activateTimer", "_remapTimer"]) {
            if (this[t]) {
                Mainloop.source_remove(this[t]);
                this[t] = 0;
            }
        }
        if (this._mapId)
            global.window_manager.disconnect(this._mapId);
        this.actor.disconnect(this._mappedId);
        for (let id of [this._eventId, this._destroyId]) {
            if (id) {
                try {
                    this.trayIcon.disconnect(id);
                } catch (e) { /* icon already gone */ }
            }
        }
        this._eventId = this._destroyId = 0;
        this.icon_holder.set_child(null);   // the tray icon itself belongs to Cinnamon
        super.destroy();
    }
}

/* ------------------------------------------------------------------------ */
/* The applet                                                               */
/* ------------------------------------------------------------------------ */

class UnifiedTrayApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        _applet = this;
        this.metadata = metadata;
        this.orientation = orientation;
        this.entries = new Map();
        this.menuEntry = null;
        this.menuToken = 0;
        this._scaleUpdateId = 0;

        this.trayManager = null;
        this.xappMonitor = null;
        this.watcherId = 0;
        this.hostOwnId = 0;
        this.hostName = "";
        this.watcherSubIds = [];

        this.gtkBridge = new GtkMenuBridge(metadata.path + "/gtk-menu-helper.py");
        this.menuCache = {};          // stored translated menus: "<id>|<button>" -> {items, epoch, sig}
        this._scanBusy = false;
        this._menuClosedAt = 0;
        this._suppressedSni = new Set();
        this.loadMenuCache();

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        /* Same container setup as the stock xapp-status applet */
        this.actor.remove_style_class_name("applet-box");
        this.actor.add_style_class_name("unified-tray");
        this.actor.set_important(true); // ensure we get class details from the default theme if not present

        if (isVertical(orientation))
            this.manager_container = new St.BoxLayout({ vertical: true, style: VERTICAL_STYLE });
        else
            this.manager_container = new St.BoxLayout({ vertical: false, style: HORIZONTAL_STYLE });
        this.actor.add_actor(this.manager_container);
        this.manager_container.show();
        this.manager_container._delegate = {
            handleDragOver: (...args) => this.handleDragOver(...args),
            acceptDrop: (...args) => this.acceptDrop(...args)
        };

        this._stage("settings", () => this._bindSettings(metadata, instanceId));
        this._stage("menu", () => this._createMenu());

        this.signalManager = new SignalManager.SignalManager(null);
        this._stage("signals", () => {
            let connect = (obj, sig, cb) => {
                try {
                    this.signalManager.connect(obj, sig, cb, this);
                } catch (e) {
                    warn("could not connect '" + sig + "'", e);
                }
            };
            connect(Gtk.IconTheme.get_default(), "changed", this.refreshIcons);
            connect(global.settings, "changed::panel-edit-mode", this.on_panel_edit_mode_changed);
            connect(Main.systrayManager, "changed", this.onSystrayRolesChanged);
            /* HACK (as in the stock applet) - this applet holds both symbolic and full-colour icons, so
             * listen to the panel signal directly to always receive icon size updates. */
            connect(this.panel, "icon-size-changed", this.refreshIcons);
            connect(global, "scale-changed", this.ui_scale_changed);
        });

        this._stage("legacy tray", () => this._startLegacy());
        this._stage("xapp", () => this._startXApp());
        this._stage("statusnotifier", () => this._startSni());

    }

    /* Run one start-up step; a failure is logged but doesn't stop the others. */
    _stage(name, fn) {
        try {
            fn();
        } catch (e) {
            global.logError("[" + UUID + "] start-up step '" + name + "' failed: " + e + "\n" + (e && e.stack ? e.stack : ""));
        }
    }

    /* ---- settings ---- */
    _bindSettings(metadata, instanceId) {
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        let cb = () => this._onSettingsChanged();
        for (let [key, prop] of [
            ["left-click-action", "leftClickAction"], ["hidden-icons", "hiddenIcons"],
            ["right-click-native", "rightClickNative"], ["hide-open-for", "hideOpenFor"],
            ["learned-no-open", "learnedNoOpen"], ["icon-order", "iconOrder"]
        ])
            this.settings.bind(key, prop, cb);
    }

    /* "Open <application>" entries belong to the "Show the menu" mode of the left-click setting */
    get showOpenEntry() {
        return this.leftClickAction !== "activate";
    }

    _onSettingsChanged() {
        for (let e of this.entries.values())
            e.updateVisibility();
        this.sortEntries();
    }

    isUserHidden(entry) {
        return this.listMatches(this.hiddenIcons, entry);
    }

    /* ---- "Open ..." entries that do nothing ---- */
    _list(str) {
        return String(str || "").toLowerCase().split(",").map(x => x.trim()).filter(x => x.length > 0);
    }

    isLearned(id) {
        return !!id && this._list(this.learnedNoOpen).indexOf(id.toLowerCase()) >= 0;
    }

    markLearned(id) {
        if (!id || this.isLearned(id))
            return;
        let list = this._list(this.learnedNoOpen);
        list.push(id.toLowerCase());
        this.learnedNoOpen = list.join(",");
    }

    forgetLearned(id) {
        let want = String(id || "").toLowerCase();
        this.learnedNoOpen = this._list(this.learnedNoOpen).filter(x => x !== want).join(",");
    }

    /* Settings button: forget everything learned about icons, the stored menus and the saved icon order */
    on_reset_learned() {
        this.iconOrder = "";
        this.sortEntries();
        this.learnedNoOpen = "";
        this.menuCache = {};
        try {
            Gio.File.new_for_path(this._menuCachePath()).delete(null);
        } catch (e) { /* none stored */ }
        for (let e of this.entries.values()) {
            e.noopCount = 0;
            if (e.kind === "xapp") {
                e.primaryIsMenu = false;
                e.lastButton = 3;
            }
        }
    }

    /* True if any word of the comma separated list occurs in one of the entry's names */
    listMatches(listStr, entry) {
        let words = this._list(listStr);
        if (words.length === 0)
            return false;
        let names = entry.matchNames().filter(n => !!n).map(n => String(n).toLowerCase());
        return words.some(h => names.some(n => n.indexOf(h) >= 0));
    }

    isOpenSuppressed(entry) {
        if (this.listMatches(this.hideOpenFor, entry))
            return true;
        let sid = entry.stableId();
        return !!sid && this.isLearned(sid);
    }

    /*
     * Run an entry's "open" action and watch whether anything observable happens (one of the
     * application's windows appears or gets focus, or - via wasPopup - a menu opened). If the
     * application has no window and nothing happens three times in a row, the entry is considered
     * to do nothing and its "Open" entry is hidden from then on.
     */
    runOpen(entry, action, wasPopup) {
        if (!entry.pid || !entry.stableId()) {
            action();
            return;
        }
        let hadWindow = entry.hasWindow();
        let done = false;
        let hooks = [];
        let timer = 0;
        let finish = (happened) => {
            if (done)
                return;
            done = true;
            for (let [obj, id] of hooks) {
                try {
                    obj.disconnect(id);
                } catch (e) { /* ignore */ }
            }
            if (timer) {
                Mainloop.source_remove(timer);
                timer = 0;
            }
            if (entry.destroyed)
                return;
            if (happened || hadWindow || (wasPopup && wasPopup())) {
                entry.noopCount = 0;
                return;
            }
            entry.noopCount = (entry.noopCount || 0) + 1;
            if (entry.noopCount >= 3) {
                this.markLearned(entry.stableId());
            }
        };
        try {
            hooks.push([global.window_manager, global.window_manager.connect("map", (wm, actor) => {
                if (entry.windowMatches(actor.meta_window))
                    finish(true);
            })]);
            hooks.push([global.window_manager, global.window_manager.connect("unminimize", (wm, actor) => {
                if (entry.windowMatches(actor.meta_window))
                    finish(true);
            })]);
            hooks.push([global.display, global.display.connect("notify::focus-window", () => {
                if (entry.windowMatches(global.display.focus_window))
                    finish(true);
            })]);
        } catch (e) { /* observation is best effort */ }
        timer = Mainloop.timeout_add(1800, () => {
            timer = 0;
            finish(false);
            return false;
        });
        action();
    }

    /* ---- stored (cached) translated menus ---- */
    _menuCachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), "unified-tray", "menus.json"]);
    }

    loadMenuCache() {
        try {
            let [ok, data] = GLib.file_get_contents(this._menuCachePath());
            if (!ok)
                return;
            let obj = JSON.parse(bytesToString(data));
            for (let [key, items] of Object.entries(obj)) {
                if (Array.isArray(items))
                    this.menuCache[key] = { items: items, epoch: 0, sig: JSON.stringify(items) };   // epoch 0: ids not usable
            }
        } catch (e) { /* no stored menus yet */ }
    }

    _saveMenuCache() {
        try {
            let out = {};
            for (let [key, rec] of Object.entries(this.menuCache))
                out[key] = JSON.parse(rec.sig);
            GLib.mkdir_with_parents(GLib.build_filenamev([GLib.get_user_cache_dir(), "unified-tray"]), 0o755);
            GLib.file_set_contents(this._menuCachePath(), JSON.stringify(out));
        } catch (e) {
            warn("could not store menus", e);
        }
    }

    cachedMenu(id, button) {
        return id ? (this.menuCache[id + "|" + button] || null) : null;
    }

    storeMenu(id, button, items, epoch) {
        if (!id)
            return;
        let key = id + "|" + button;
        let sig = JSON.stringify(stripIds(items));
        let old = this.menuCache[key];
        this.menuCache[key] = { items: items, epoch: epoch, sig: sig };
        if (!old || old.sig !== sig)
            this._saveMenuCache();
    }

    /* A menu that is open for this entry got new content (e.g. read late): rebuild it */
    menuContentChanged(entry) {
        if (this.menuEntry === entry && this.menu.isOpen)
            this._renderMenu();
    }

    pointerButtonsDown() {
        let [x, y, mods] = global.get_pointer();
        let mask = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
            Clutter.ModifierType.BUTTON3_MASK;
        return (mods & mask) !== 0;
    }

    /* The same application may register its icon twice; keep only the first one */
    dedupeSni(entry) {
        if (entry._dedupeDone || !entry.pid)
            return;
        let id = entry.stableId();
        if (!id)
            return;
        entry._dedupeDone = true;
        for (let other of this.entries.values()) {
            if (other !== entry && other.kind === "sni" && !other.destroyed && other.pid === entry.pid &&
                other.stableId() === id) {
                this._suppressedSni.add(entry.key);
                this.removeEntry(entry.key);
                return;
            }
        }
    }

    /* ---- panel integration (mirrors the stock applet) ---- */
    refreshIcons() {
        for (let entry of this.entries.values())
            entry.refresh();
    }

    ui_scale_changed() {
        if (this._scaleUpdateId > 0)
            Mainloop.source_remove(this._scaleUpdateId);
        this._scaleUpdateId = Mainloop.timeout_add(1500, () => {
            this.refreshIcons();
            this._scaleUpdateId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    onSystrayRolesChanged() {
        for (let entry of this.entries.values())
            entry.updateVisibility();
    }

    on_panel_edit_mode_changed() {
        this.menu.close(false);
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        if (isVertical(orientation)) {
            this.manager_container.vertical = true;
            this.manager_container.style = VERTICAL_STYLE;
        } else {
            this.manager_container.vertical = false;
            this.manager_container.style = HORIZONTAL_STYLE;
        }
        this.menu.close(false);
        this._newMenu();
        this.refreshIcons();
    }

    on_applet_removed_from_panel() {
        this._shutdown();
    }

    /* Saved order first; the rest as the stock applet does it: symbolic icons last, then by name */
    sortEntries() {
        let order = String(this.iconOrder || "").split("|").filter(k => k);
        let list = Array.from(this.entries.values());
        let isSym = (e) => String(e.iconName || "").includes("-symbolic");
        list.sort((a, b) => {
            let ia = order.indexOf(a.orderKey());
            let ib = order.indexOf(b.orderKey());
            if (ia >= 0 && ib >= 0)
                return ia - ib;
            if (ia >= 0)
                return -1;
            if (ib >= 0)
                return 1;
            let aSym = isSym(a);
            let bSym = isSym(b);
            if (aSym && !bSym)
                return 1;
            if (bSym && !aSym)
                return -1;
            return GLib.utf8_collate(a.sortName(), b.sortName());
        });
        list.forEach((entry, i) => this.manager_container.set_child_at_index(entry.actor, i));
    }

    /* ---- reordering by drag and drop (panel edit mode, Shift/Ctrl + drag) ---- */
    dragBegan(entry) {
        this.menu.close(false);
        this._dragOrder = this.manager_container.get_children();
        this._dropAccepted = false;
        entry.actor.opacity = 110;
    }

    dragEnded(entry) {
        entry.actor.opacity = 255;
        if (!this._dropAccepted && this._dragOrder) {
            /* Dropped somewhere else: back to the order before the drag */
            this._dragOrder.forEach((a, i) => {
                try {
                    if (a.get_parent() === this.manager_container)
                        this.manager_container.set_child_at_index(a, i);
                } catch (e) { /* icon was removed meanwhile */ }
            });
        }
        this._dragOrder = null;
    }

    /* While dragging over the icons, the dragged icon moves to where it would land */
    handleDragOver(source, dragActor, x, y) {
        if (!(source instanceof TrayEntry))
            return DND.DragMotionResult.CONTINUE;
        let vertical = this.manager_container.vertical;
        let pos = vertical ? y : x;
        let others = this.manager_container.get_children().filter(a => a !== source.actor);
        let before = others.find(a => {
            if (!a.visible)
                return false;
            let [ax, ay] = a.get_position();
            let [aw, ah] = a.get_size();
            return pos < (vertical ? ay + ah / 2 : ax + aw / 2);
        });
        others.splice(before ? others.indexOf(before) : others.length, 0, source.actor);
        others.forEach((a, i) => this.manager_container.set_child_at_index(a, i));
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!(source instanceof TrayEntry))
            return false;
        this._saveOrder();
        this._dropAccepted = true;
        return true;
    }

    /* Remember the current order of the icons */
    _saveOrder() {
        let keys = this.manager_container.get_children()
            .map(a => (a._delegate && a._delegate.orderKey) ? a._delegate.orderKey() : null).filter(k => k);
        this.iconOrder = this._mergeOrder(keys).join("|");
    }

    /* The new order of the running icons, keeping the saved position of icons that are not running right now */
    _mergeOrder(visible) {
        let old = String(this.iconOrder || "").split("|").filter(k => k);
        let result = visible.slice();
        old.forEach((k, i) => {
            if (result.indexOf(k) >= 0)
                return;
            result.splice((i > 0 ? result.indexOf(old[i - 1]) : -1) + 1, 0, k);
        });
        return result;
    }

    /* ---- menu ---- */
    _createMenu() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = null;
        this._newMenu();
    }

    /*
     * A brand new PopupMenu is used for every opening. Re-using one keeps the
     * size negotiated for the previous content, so menus ended up too big or
     * too small when switching between icons.
     */
    _newMenu() {
        let old = this.menu;
        if (old) {
            try {
                old.close(false);
                this.menuManager.removeMenu(old);
                old.destroy();
            } catch (e) {
                warn("could not dispose old menu", e);
            }
        }
        let menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menu = menu;
        this.menuManager.addMenu(menu);
        this._menuScroll = null;
        menu.connect("open-state-changed", (m, open) => {
            if (m !== this.menu)
                return;
            if (!open) {
                let closedEntry = this.menuEntry;
                this.menuEntry = null;
                this.menuToken++;
                this._menuClosedAt = Clutter.get_current_event_time();
                if (closedEntry && typeof closedEntry.scheduleRefresh === "function")
                    closedEntry.scheduleRefresh(0);
            }
        });
    }

    /*
     * If a menu is open (or was closed by this very click's press), the click only closes it and the
     * matching release is ignored - exactly how clicking another panel applet behaves.
     */
    consumeClickIfMenuOpen(event) {
        let t = event.get_time();
        let wasOpen = this.menu.isOpen || (!!this._menuClosedAt && Math.abs(t - this._menuClosedAt) < 50);
        if (!wasOpen)
            return false;
        if (this.menu.isOpen)
            this.menu.close(true);
        return true;
    }

    toggleMenuFor(entry) {
        if (this.menu.isOpen) {
            this.menu.close(true);
            return;
        }
        this.menuEntry = entry;
        let token = ++this.menuToken;
        let ready = false;
        let watchdog = 0;
        let finish = (ok) => {
            if (ready)
                return;
            ready = true;
            if (watchdog) {
                Mainloop.source_remove(watchdog);
                watchdog = 0;
            }
            if (token !== this.menuToken || entry.destroyed)
                return;
            if (ok === false) {
                /* The application's own menu is showing instead (graceful fallback) */
                this.menuEntry = null;
                return;
            }
            this._newMenu();
            this.menu.sourceActor = entry.actor;
            this._renderMenu();
            this.menu.open(true);
        };
        /* Never leave the user without a menu because an application answers slowly */
        watchdog = Mainloop.timeout_add(3500, () => {
            watchdog = 0;
            if (!ready) {
                warn("preparing the menu of " + entry.displayName() + " took too long; showing what is available");
                finish(true);
            }
            return false;
        });
        entry.prepareMenu(finish);
    }

    /* Available height for a menu opened from this entry (so long menus scroll instead of leaving the screen) */
    _maxMenuHeight(entry) {
        try {
            let monitor = Main.layoutManager.findMonitorForActor(entry.actor) || Main.layoutManager.primaryMonitor;
            let [, y] = entry.actor.get_transformed_position();
            let h = entry.actor.get_height();
            let avail;
            switch (this.orientation) {
                case St.Side.TOP:
                    avail = monitor.y + monitor.height - (y + h);
                    break;
                case St.Side.BOTTOM:
                    avail = y - monitor.y;
                    break;
                default:
                    avail = monitor.height;
            }
            return Math.max(200, Math.floor((avail - 40) / global.ui_scale));
        } catch (e) {
            return 600;
        }
    }

    _renderMenu() {
        let entry = this.menuEntry;
        if (!entry)
            return;
        this.menu.removeAll();
        if (this._menuScroll) {
            this._menuScroll.destroy();
            this._menuScroll = null;
        }
        this.menu.actor.set_size(-1, -1);
        if (this.menu.box)
            this.menu.box.set_size(-1, -1);

        /* Items live in a section inside a scroll view whose height is capped to the screen */
        let section = new PopupMenu.PopupMenuSection();
        section._getTopMenu = () => this.menu;          // activating an item must close the whole menu
        section.itemActivated = () => this.menu.close(true);
        let scroll = new St.ScrollView({
            x_fill: true,
            y_fill: false,
            y_align: St.Align.START,
            style_class: "vfade"
        });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.style = "max-height: " + this._maxMenuHeight(entry) + "px;";
        scroll.add_actor(section.actor);
        if (typeof this.menu.addActor === "function")
            this.menu.addActor(scroll);
        else
            this.menu.box.add_actor(scroll);
        this._menuScroll = scroll;

        try {
            entry.fillMenu(section);
        } catch (e) {
            warn("failed to build menu", e);
        }
        let empty = typeof section.isEmpty === "function" ? section.isEmpty() : false;
        if (empty) {
            let item = new PopupMenu.PopupMenuItem(_("No actions available"));
            item.setSensitive(false);
            section.addMenuItem(item);
        }
    }

    /* Open the (already prepared) menu of an entry right away */
    openMenuNow(entry) {
        if (entry.destroyed)
            return;
        if (this.menu.isOpen)
            this.menu.close(false);
        this.menuEntry = entry;
        this.menuToken++;
        this._newMenu();
        this.menu.sourceActor = entry.actor;
        this._renderMenu();
        this.menu.open(true);
    }

    /* Called when an application changed its dbusmenu while we show it. */
    menuLayoutChanged(entry) {
        if (this.menuEntry !== entry || !this.menu.isOpen || !entry.menuClient)
            return;
        entry.menuClient.fetch((changed) => {
            if (changed && this.menuEntry === entry && this.menu.isOpen)
                this._renderMenu();
        });
    }

    /*
     * While we read an application's native popup menu through AT-SPI, keep that
     * popup invisible. reveal() shows it again (used when reading fails, so the
     * user simply gets the application's own menu).
     */
    hidePopupsFor(pid) {
        let hidden = [];
        let signalId = 0;
        let timer = 0;
        let stopped = false;

        let stop = () => {
            if (stopped)
                return;
            stopped = true;
            if (signalId) {
                global.window_manager.disconnect(signalId);
                signalId = 0;
            }
            if (timer) {
                Mainloop.source_remove(timer);
                timer = 0;
            }
        };

        try {
            signalId = global.window_manager.connect("map", (wm, actor) => {
                try {
                    let win = actor.meta_window;
                    if (win && win.get_pid() === pid && win.is_override_redirect()) {
                        actor.opacity = 0;
                        hidden.push(actor);
                    }
                } catch (e) { /* ignore */ }
            });
        } catch (e) {
            signalId = 0;
        }
        timer = Mainloop.timeout_add(6000, () => {
            timer = 0;
            stop();
            return false;
        });

        return {
            stop: stop,
            count: () => hidden.length,
            reveal: () => {
                stop();
                for (let actor of hidden) {
                    try {
                        actor.opacity = 255;
                    } catch (e) { /* ignore */ }
                }
            }
        };
    }

    /* ---- entry bookkeeping ---- */
    _registerEntry(entry) {
        this.entries.set(entry.key, entry);
        this.manager_container.add_actor(entry.actor);
        this.sortEntries();
    }

    removeEntry(key) {
        let entry = this.entries.get(key);
        if (!entry)
            return;
        if (this.menuEntry === entry)
            this.menu.close(false);
        this.entries.delete(key);
        entry.destroy();
        this.sortEntries();
    }

    /* ---- XApp ---- */
    _startXApp() {
        if (!XApp || !XApp.StatusIconMonitor) {
            warn("libxapp StatusIconMonitor is not available; XApp icons will not be shown");
            return;
        }
        try {
            this.xappMonitor = new XApp.StatusIconMonitor();
            this.signalManager.connect(this.xappMonitor, "icon-added", (m, proxy) => this._addXApp(proxy), this);
            this.signalManager.connect(this.xappMonitor, "icon-removed", (m, proxy) => this._removeXApp(proxy), this);
            let existing = typeof this.xappMonitor.list_icons === "function" ? this.xappMonitor.list_icons() : [];
            if (existing && typeof existing[Symbol.iterator] === "function") {
                for (let proxy of existing)
                    this._addXApp(proxy);
            }
        } catch (e) {
            warn("could not start XApp status icon monitor", e);
        }
    }

    _addXApp(proxy) {
        let key = XAppEntry.keyFor(proxy);
        if (this.entries.has(key))
            return;
        try {
            this._registerEntry(new XAppEntry(this, proxy));
        } catch (e) {
            global.logError("[" + UUID + "] could not add XApp icon " + key + ": " + e + "\n" + (e && e.stack ? e.stack : ""));
        }
    }

    _removeXApp(proxy) {
        this.removeEntry(XAppEntry.keyFor(proxy));
    }

    /* ---- StatusNotifier ---- */
    _startSni() {
        this.watcherId = Gio.bus_watch_name(Gio.BusType.SESSION, SNI_WATCHER, Gio.BusNameWatcherFlags.NONE,
            () => this._onWatcherAppeared(),
            () => this._onWatcherVanished());
    }

    _onWatcherAppeared() {
        this.watcherPresent = true;
        if (!this._sniPoll) {
            /* Safety net: re-list items every few seconds so a newly started application's icon always shows up */
            this._sniPoll = Mainloop.timeout_add_seconds(5, () => {
                if (this.watcherPresent)
                    this._syncSni();
                return true;
            });
        }
        if (this.watcherSubIds.length === 0) {
            let bus = Gio.DBus.session;
            this.watcherSubIds.push(bus.signal_subscribe(SNI_WATCHER, SNI_WATCHER, "StatusNotifierItemRegistered",
                SNI_WATCHER_PATH, null, Gio.DBusSignalFlags.NONE,
                (c, s, p, i, sig, params) => this._addSni(params.deepUnpack()[0])));
            this.watcherSubIds.push(bus.signal_subscribe(SNI_WATCHER, SNI_WATCHER, "StatusNotifierItemUnregistered",
                SNI_WATCHER_PATH, null, Gio.DBusSignalFlags.NONE,
                (c, s, p, i, sig, params) => {
                    let key = SniEntry.normalize(params.deepUnpack()[0]).key;
                    this._suppressedSni.delete(key);
                    this.removeEntry(key);
                }));
        }

        if (!this.hostOwnId) {
            this.hostName = "org.kde.StatusNotifierHost-" + GLib.get_monotonic_time() + "-" + this.instance_id;
            this.hostOwnId = Gio.bus_own_name(Gio.BusType.SESSION, this.hostName,
                Gio.BusNameOwnerFlags.NONE,
                () => { /* bus acquired */ },
                () => this._registerHostAndList(),
                () => { /* name lost */ });
        } else {
            this._registerHostAndList();
        }
    }

    _registerHostAndList() {
        sessionCall(SNI_WATCHER, SNI_WATCHER_PATH, SNI_WATCHER, "RegisterStatusNotifierHost",
            new GLib.Variant("(s)", [this.hostName]), null, (res, err) => {
                if (err)
                    warn("RegisterStatusNotifierHost failed", err);
            });
        this._syncSni();
    }

    /* Add every item the watcher lists that we don't show yet (signals can be missed or arrive early). */
    _syncSni() {
        sessionCall(SNI_WATCHER, SNI_WATCHER_PATH, PROPS_IFACE, "Get",
            new GLib.Variant("(ss)", [SNI_WATCHER, "RegisteredStatusNotifierItems"]), "(v)", (res, err) => {
                if (!res) {
                    warn("could not list StatusNotifier items", err);
                    return;
                }
                try {
                    for (let item of res.recursiveUnpack()[0])
                        this._addSni(item);
                } catch (e) {
                    warn("bad StatusNotifier item list", e);
                }
            });
    }

    syncSniSoon() {
        for (let delay of [300, 1500]) {
            Mainloop.timeout_add(delay, () => {
                if (this.watcherPresent)
                    this._syncSni();
                return false;
            });
        }
    }

    _onWatcherVanished() {
        this.watcherPresent = false;
        this._suppressedSni.clear();
        for (let [key, entry] of Array.from(this.entries.entries())) {
            if (entry.kind === "sni")
                this.removeEntry(key);
        }
    }

    _addSni(registered) {
        if (typeof registered !== "string" || registered.length === 0 || registered.startsWith("/"))
            return;
        let key = SniEntry.normalize(registered).key;
        if (this.entries.has(key) || this._suppressedSni.has(key))
            return;
        try {
            this._registerEntry(new SniEntry(this, registered));
        } catch (e) {
            global.logError("[" + UUID + "] could not add StatusNotifier item " + registered + ": " + e + "\n" + (e && e.stack ? e.stack : ""));
        }
    }

    /* ---- legacy XEmbed ---- */
    _startLegacy() {
        if (this.trayManager)
            return;
        try {
            this.trayManager = new Cinnamon.TrayManager();
            this.trayManager.connect("tray-icon-added", (o, icon, role) => this._addLegacy(icon, role));
            this.trayManager.connect("tray-icon-removed", (o, icon) => this._removeLegacy(icon));
            if (!this._manageTray(this.trayManager)) {
                this.trayManager = null;
                return;
            }
        } catch (e) {
            warn("could not start legacy tray support (is another System Tray applet loaded?)", e);
            this.trayManager = null;
        }
    }

    /* The signature of manage_screen differs between Cinnamon releases */
    _manageTray(manager) {
        for (let args of [[this.actor], [global.screen, this.actor], [global.display, this.actor]]) {
            try {
                manager.manage_screen(...args);
                return true;
            } catch (e) { /* try the next form */ }
        }
        warn("legacy tray: manage_screen failed");
        return false;
    }

    _addLegacy(icon, role) {
        try {
            let hidden = Main.systrayManager.getRoles();
            if (hidden.indexOf(String(role || icon.wm_class || "").toLowerCase()) != -1) {
                return;
            }
        } catch (e) { /* no systray manager */ }
        try {
            this._registerEntry(new EmbeddedEntry(this, icon, role));
        } catch (e) {
            global.logError("[" + UUID + "] could not add legacy tray icon: " + e + "\n" + (e && e.stack ? e.stack : ""));
        }
    }

    _removeLegacy(icon) {
        for (let [key, entry] of Array.from(this.entries.entries())) {
            if (entry.kind === "xembed" && entry.trayIcon === icon) {
                this.removeEntry(key);
                return;
            }
        }
    }

    /* ---- teardown ---- */
    _shutdown() {
        if (_applet === this)
            _applet = null;
        if (this._scaleUpdateId > 0) {
            Mainloop.source_remove(this._scaleUpdateId);
            this._scaleUpdateId = 0;
        }
        if (this.signalManager)
            this.signalManager.disconnectAllSignals();
        if (this.menu)
            this.menu.close(false);
        for (let key of Array.from(this.entries.keys()))
            this.removeEntry(key);
        if (this.watcherId) {
            Gio.bus_unwatch_name(this.watcherId);
            this.watcherId = 0;
        }
        for (let id of this.watcherSubIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this.watcherSubIds = [];
        if (this.hostOwnId) {
            Gio.bus_unown_name(this.hostOwnId);
            this.hostOwnId = 0;
        }
        if (this._sniPoll) {
            Mainloop.source_remove(this._sniPoll);
            this._sniPoll = 0;
        }
        this.gtkBridge.destroy();
        this.xappMonitor = null;
        this.trayManager = null;
        if (this.settings)
            this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new UnifiedTrayApplet(metadata, orientation, panelHeight, instanceId);
}
