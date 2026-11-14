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
const RadioButton = imports.ui.radioButton;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
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

/* Hiding icons that are not used (see "hiding icons" in the applet) */
const AUTOHIDE_TICK = 60;              // seconds between checks
const AUTOHIDE_IDLE_LIMIT = 5 * 60;    // seconds without keyboard/mouse input after which time stops counting
const AUTOHIDE_FORGET_DAYS = 180;      // what is known about icons not seen for this long is dropped

/* ------------------------------------------------------------------------ */
/* Generic helpers                                                          */
/* ------------------------------------------------------------------------ */

function warn(msg, e) {
    global.logWarning("[" + UUID + "] " + msg + (e ? ": " + e : ""));
}

/*
 * While a menu is open its panel button stays highlighted, so it is clear which icon the menu belongs to.
 * Many themes (Mint-Y among them) don't style ":checked" for applets, so the button also keeps the theme's
 * hover look: hover tracking is paused (it would drop the highlight as soon as the pointer moves into the
 * menu) and resumed, in sync with the pointer, when the menu closes.
 */
function _setHighlight(actor, on) {
    if (on) {
        if (actor._menuHighlight)
            return;
        actor._menuHighlight = { trackHover: actor.track_hover };
        actor.track_hover = false;
        actor.add_style_pseudo_class("hover");
        actor.add_style_pseudo_class("checked");
    } else {
        let saved = actor._menuHighlight;
        if (!saved)
            return;
        actor._menuHighlight = null;
        actor.remove_style_pseudo_class("checked");
        actor.remove_style_pseudo_class("hover");
        actor.track_hover = saved.trackHover;
        if (saved.trackHover)
            actor.sync_hover();
    }
}

function highlightSource(menu, open) {
    try {
        if (open) {
            let actor = menu.sourceActor;
            if (menu._highlighted && menu._highlighted !== actor)
                _setHighlight(menu._highlighted, false);
            if (actor) {
                _setHighlight(actor, true);
                menu._highlighted = actor;
            }
        } else if (menu._highlighted) {
            _setHighlight(menu._highlighted, false);
            menu._highlighted = null;
        }
    } catch (e) { /* the actor is gone */ }
}

/*
 * Tooltip for buttons inside our menus: Cinnamon's plain Tooltip (the one meant for things that are not
 * panel items; PanelItemTooltip deliberately stays hidden while a menu is open). The plain one is placed
 * at the pointer and only kept on screen sideways, so show() moves it next to its button - on the side
 * away from the panel, flipped if there is no room - and keeps it fully on screen.
 */
function MenuButtonTooltip(actor, text, orientation) {
    this._init(actor, text, orientation);
}

MenuButtonTooltip.prototype = {
    __proto__: Tooltips.Tooltip.prototype,

    _init: function (actor, text, orientation) {
        Tooltips.Tooltip.prototype._init.call(this, actor, text);
        this._button = actor;
        this.orientation = orientation;
    },

    show: function () {
        Tooltips.Tooltip.prototype.show.call(this);
        if (!this.visible)
            return;
        try {
            let actor = this._button;
            let monitor = Main.layoutManager.findMonitorForActor(actor) || Main.layoutManager.primaryMonitor;
            let [x, y] = actor.get_transformed_position();
            let [w, h] = actor.get_transformed_size();
            let [, , tw, th] = this._tooltip.get_preferred_size();
            let gap = Math.round(4 * global.ui_scale);
            let above = this.orientation !== St.Side.TOP;
            let top = above ? y - th - gap : y + h + gap;
            if (above ? top < monitor.y : top + th > monitor.y + monitor.height)
                top = above ? y + h + gap : y - th - gap;   // no room: other side
            let left = x + (w - tw) / 2;
            left = Math.max(monitor.x, Math.min(left, monitor.x + monitor.width - tw));
            top = Math.max(monitor.y, Math.min(top, monitor.y + monitor.height - th));
            this._tooltip.set_position(Math.round(left), Math.round(top));
        } catch (e) { /* keep the position Tooltip chose */ }
    }
};

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

/*
 * The .desktop application that matches best: score({id, last, exe, wm, name, launcher}) returns 0 for no
 * match, higher for a better one; on a tie the first one found wins.
 * "launcher" is true for entries that start the program with a URI (e.g. Steam's game shortcuts,
 * "steam steam://rungameid/..."): they share the program's executable but are not the program itself.
 */
function findApp(score) {
    let now = GLib.get_monotonic_time();
    if (!_appInfos || now - _appInfosAt > 30e6) {
        _appInfos = Gio.AppInfo.get_all();
        _appInfosAt = now;
    }
    let best = null;
    let bestScore = 0;
    for (let info of _appInfos) {
        let id = (info.get_id() || "").toLowerCase().replace(/\.desktop$/, "");
        let exe = "";
        let wm = "";
        try {
            exe = GLib.path_get_basename(info.get_executable() || "").toLowerCase();
            wm = String((typeof info.get_startup_wm_class === "function" && info.get_startup_wm_class()) || "").toLowerCase();
        } catch (e) { /* not a desktop application */ }
        let name = String(info.get_name() || "").toLowerCase();
        let launcher = false;
        try {
            launcher = /\w+:\/\//.test(String(info.get_commandline() || ""));
        } catch (e) { /* ignore */ }
        let s = score({ id: id, last: id.split(".").pop(), exe: exe, wm: wm, name: name, launcher: launcher });
        if (s > bestScore) {
            bestScore = s;
            best = { name: info.get_name(), gicon: info.get_icon(), id: id, wmClass: wm };
        }
    }
    return best;
}

/* Matching the executable only counts for less, and less again for shortcuts that launch something through it */
function exeScore(k, token) {
    if (!k.exe || token !== k.exe)
        return 0;
    return k.launcher ? 1 : 2;
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
        let app = findApp(k => (t === k.id || t === k.last) ? 4 : exeScore(k, t));
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
    return findApp(k => Math.max(...hs.map(h => {
        if (h === k.id || h === k.last)
            return 4;
        if ((k.wm && h === k.wm) || h === k.name)
            return 3;
        return exeScore(k, h);
    })));
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
 * labels. Items without an icon get no placeholder: their label starts at the
 * left edge, even when other items in the same menu have icons.
 */
let _applet = null;   // the running applet instance (so menu items can close its menu)

/*
 * Whether an icon name can actually be shown: a name the icon theme doesn't have
 * would leave a blank slot (and push every sibling's label to the right).
 */
function iconNameUsable(name) {
    let n = String(name || "");
    if (!n)
        return false;
    if (n.startsWith("/"))
        return GLib.file_test(n, GLib.FileTest.EXISTS);
    try {
        let theme = Gtk.IconTheme.get_default();
        if (!theme)
            return true;
        return theme.has_icon(n) || (n.endsWith("-symbolic") && theme.has_icon(n.slice(0, -"-symbolic".length)));
    } catch (e) {
        return true;
    }
}

/*
 * St.Bin-based widgets (switch, radio button) read x_align/y_align as St.Align on some
 * Cinnamon versions, so they are centered through a plain box around them instead.
 */
function centered(actor) {
    let holder = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
    holder.add_actor(actor);
    return holder;
}

/*
 * The theme's radio button (the same one Cinnamon's own menus use), not
 * reactive: the whole menu item is what gets clicked. Returns { actor, set(state) }.
 */
function makeRadioIndicator(state) {
    try {
        let rb = new RadioButton.RadioButton();
        let actor = rb.actor || rb;           // older Cinnamon versions wrap the actor
        actor.reactive = false;
        actor.can_focus = false;
        let set = (on) => {
            if (typeof rb.setChecked === "function")
                rb.setChecked(on);
            else
                actor.checked = on;
        };
        set(state);
        return { actor: centered(actor), set: set };
    } catch (e) {
        let label = new St.Label({ y_align: Clutter.ActorAlign.CENTER, style: "min-width: 1.2em;" });
        let set = (on) => label.set_text(on ? "\u25C9" : "\u25CB");
        set(state);
        return { actor: label, set: set };
    }
}

/*
 * indicator: null (no indicator column), "" (an empty slot so labels line up
 * with radio items) or { radio: state }.
 * opts.switchState (boolean) adds an on/off switch at the right edge, like the
 * switches in Cinnamon's own applet menus; opts.keepMenu keeps the menu open
 * when it is flipped. Items with an indicator or a switch get setToggleState().
 */
function makeMenuItem(text, iconActor, indicator, opts) {
    let item = new PopupMenu.PopupBaseMenuItem();
    /* Choosing an entry closes the menu (connected first, so it also happens if a later handler fails) */
    item.connect("activate", (it, event, keepMenu) => {
        if (!keepMenu && _applet && _applet.menu) {
            _applet._closedByActivation = true;
            _applet.menu.close(true);
        }
    });
    let box = new St.BoxLayout({ style: "spacing: 6px;", x_expand: true });
    if (indicator && typeof indicator === "object") {
        let radio = makeRadioIndicator(!!indicator.radio);
        box.add_actor(radio.actor);
        item.setToggleState = radio.set;
    } else if (indicator === "") {
        /* An invisible radio button takes exactly the room a visible one does */
        let slot = makeRadioIndicator(false);
        slot.actor.opacity = 0;
        box.add_actor(slot.actor);
    }
    if (iconActor) {
        iconActor.y_align = Clutter.ActorAlign.CENTER;
        box.add_actor(iconActor);
    }
    item.label = new St.Label({ text: text, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
    box.add_actor(item.label);
    if (opts && typeof opts.switchState === "boolean") {
        let sw = new PopupMenu.Switch(opts.switchState);
        box.add_actor(centered(sw.actor));
        item._switch = sw;
        item.setToggleState = (on) => sw.setToggleState(on);
        let keepMenu = !!opts.keepMenu;
        /* Like PopupSwitchMenuItem: clicking anywhere on the item flips the switch */
        item.activate = function (event) {
            if (sw.actor.mapped)
                sw.toggle();
            PopupMenu.PopupBaseMenuItem.prototype.activate.call(this, event, keepMenu);
        };
    }
    item.addActor(box, { span: -1, expand: true });
    item.actor.label_actor = item.label;
    return item;
}

/*
 * Turns a dbusmenu-shaped layout node [id, props, children] into Cinnamon
 * menu items. Subclasses provide the transport for activations.
 */
class MenuBuilder {
    constructor() {
        this.toggleItems = {};          // dbusmenu id -> shown checkmark/radio item
        this.keepMenuOnToggle = false;  // whether flipping a switch leaves the menu open
    }

    sendEvent(id, type) { /* subclass */ }
    onSubmenuState(id, item, open) { /* subclass */ }
    onToggleSent() { /* subclass */ }

    /* The layout with the toggle states left out: equal keys mean only switches/radios changed */
    shapeKey() {
        return JSON.stringify(this.layout, (k, v) => k === "toggle-state" ? undefined : v);
    }

    /* Show the layout's toggle states on the items in the open menu; false if some item is missing */
    applyToggleStates() {
        let ok = true;
        let walk = (node) => {
            for (let kid of (node && node[2]) || []) {
                let p = kid[1] || {};
                if (p.visible !== false && (p["toggle-type"] === "checkmark" || p["toggle-type"] === "radio")) {
                    let item = this.toggleItems[kid[0]];
                    if (item && item.setToggleState)
                        item.setToggleState(p["toggle-state"] === 1);
                    else
                        ok = false;
                }
                walk(kid);
            }
        };
        walk(this.layout);
        return ok;
    }

    _visibleItems(node) {
        let kids = (node && node[2]) || [];
        return kids.filter(k => k[1].visible !== false && k[1].type !== "separator");
    }

    populate(shell) {
        this.toggleItems = {};
        if (this.layout)
            this._buildChildren(shell, this.layout);
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

    _buildChildren(shell, node) {
        let kids = node[2] || [];
        /* Only radio items have a mark in front of the label (checkmark items get a switch at the end) */
        let anyRadio = kids.some(k => k[1].visible !== false && k[1].type !== "separator" &&
            k[1]["toggle-type"] === "radio");
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
            shell.addMenuItem(this._makeItem(id, props, sub, anyRadio));
        }
    }

    _makeItem(id, props, sub, reserveToggle) {
        let label = cleanLabel(props.label);
        let enabled = props.enabled !== false;

        if (props["children-display"] === "submenu" || sub.length > 0) {
            let item = new PopupMenu.PopupSubMenuMenuItem(label);
            this._buildChildren(item.menu, [id, props, sub]);
            item.setSensitive(enabled);
            item.menu.connect("open-state-changed", (menu, open) => this.onSubmenuState(id, item, open));
            return item;
        }

        let iconActor = null;
        try {
            if (iconNameUsable(props["icon-name"])) {
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

        let toggleType = props["toggle-type"];
        let on = props["toggle-state"] === 1;
        let indicator = reserveToggle ? "" : null;
        let opts = null;
        if (toggleType === "checkmark")
            opts = { switchState: on, keepMenu: this.keepMenuOnToggle };
        else if (toggleType === "radio")
            indicator = { radio: on };

        let item = makeMenuItem(label, iconActor, indicator, opts);

        item.setSensitive(enabled);
        item.connect("activate", () => {
            this.sendEvent(id, "clicked");
            if (opts && opts.keepMenu)
                this.onToggleSent();
        });
        if (toggleType === "checkmark" || toggleType === "radio") {
            this.toggleItems[id] = item;
            item.connect("destroy", () => {
                if (this.toggleItems[id] === item)
                    delete this.toggleItems[id];
            });
        }
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
        this.resyncTimer = 0;
        this.subIds = [];
        /* The application tells about the new state, so a switch can stay in an open menu */
        this.keepMenuOnToggle = true;

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

    /*
     * After a switch was flipped in the open menu, read the menu again a little later even if the
     * application sent no signal, so a switch the application did not follow flips back.
     */
    onToggleSent() {
        if (this.resyncTimer)
            Mainloop.source_remove(this.resyncTimer);
        this.resyncTimer = Mainloop.timeout_add(700, () => {
            this.resyncTimer = 0;
            if (!this.destroyed)
                this.onExternalChange();
            return false;
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
        if (this.resyncTimer) {
            Mainloop.source_remove(this.resyncTimer);
            this.resyncTimer = 0;
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

/*
 * GTK does not tell what icon a menu entry has, so common entries get the standard icon of that name
 * (applications use these names for them).
 */
const GTK_ITEM_ICONS = {
    "refresh": "view-refresh-symbolic", "reload": "view-refresh-symbolic",
    "information": "dialog-information-symbolic", "info": "dialog-information-symbolic",
    "about": "help-about-symbolic", "help": "help-browser-symbolic",
    "preferences": "preferences-other-symbolic", "options": "preferences-other-symbolic",
    "settings": "preferences-system-symbolic",
    "quit": "application-exit-symbolic", "exit": "application-exit-symbolic",
    "close": "window-close-symbolic", "open": "document-open-symbolic"
};

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
        let icon = it.icon || (kids.length === 0 ? GTK_ITEM_ICONS[label.replace(/[.\u2026_]+$/, "").replace(/_/g, "").trim().toLowerCase()] : null);
        if (icon)
            props["icon-name"] = icon;
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
        if (button == Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            this.applet.noteContextEntry(this);
            return EVENT_PROPAGATE; // let the applet's own context menu open
        }

        /* A click while a menu is open (or that has just closed one) only closes it */
        if (this.applet.consumeClickIfMenuOpen(event)) {
            this._pressedButton = 0;
            return EVENT_STOP;
        }

        this.applet.noteActivity(this);
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
        if (direction != Clutter.ScrollDirection.SMOOTH) {
            this.applet.noteActivity(this);
            this.scroll(direction, event);
        }
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

    /*
     * Repeat a click made on this icon in the hidden icons menu, once the icon is back in the panel
     * (so menus and applications see the icon's real position).
     */
    replayClick(button) {
        this.lastEventTime = global.get_current_time();
        this._pressedButton = 0;
        this._releaseWaiters = [];
        if (this.forwardsRaw(button)) {
            if (typeof this.synthClick === "function")
                this.synthClick(button, this.lastEventTime);
        } else {
            this.handleClick(button, null);
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
        let shown = !this.destroyed && this.computeVisible() && !this.applet.isUserHidden(this);
        /* Auto-hidden icons stay hidden in the panel; they are only shown inside the hidden icons menu */
        this.autoHidden = shown && this.applet.isAutoHidden(this);
        this.actor.visible = shown && (!this.autoHidden || !!this.inOverflow);
        this.applet.updateOverflowButton();
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

        /* The "Open" entry sits above a separator, so its icon doesn't indent the items below */
        if (wantOpen)
            this.addOpenItem(menu, () => this.activate());

        if (this.hasDbusMenu() && !hasItems)
            warn("dbusmenu " + this.props.Menu + " of " + this.busName + " returned no visible items");

        if (hasItems) {
            if (wantOpen)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            source.populate(menu);
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

        this._primaryVerified = false;   // true once a left-click menu was really read in this session
        this._clickBusyUntil = 0;
        this.primaryIsMenu = this.applet.isLearned(this.stableId() + "#menu3");   // learned: a left click opens a menu, not a window
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
        /* While this click plays out nothing else may open the application's popups in the background */
        this._clickBusyUntil = GLib.get_monotonic_time() + 4e6;
        let hider = applet.hidePopupsFor(this.pid);

        /* If the click opens one of the application's windows, it was not a menu click */
        let opened = false;
        let hooks = [];
        let watch = (obj, signal, fn) => hooks.push([obj, obj.connect(signal, fn)]);
        let isWindow = (win) => !!win && !win.is_override_redirect() && this.windowMatches(win);
        watch(global.window_manager, "map", (wm, actor) => {
            if (isWindow(actor.meta_window))
                opened = true;
        });
        watch(global.window_manager, "unminimize", (wm, actor) => {
            if (isWindow(actor.meta_window))
                opened = true;
        });
        watch(global.display, "notify::focus-window", () => {
            if (isWindow(global.display.focus_window))
                opened = true;
        });
        let unwatch = () => {
            for (let [obj, id] of hooks)
                obj.disconnect(id);
            hooks = [];
        };

        this.synthClick(1, time);
        let tries = 0;
        Mainloop.timeout_add(100, () => {
            if (this.destroyed || opened) {
                unwatch();
                hider.stop();
                return false;
            }
            /* A popup of the application that is not our own background menu reading: the click's menu */
            if (hider.count() > 0 && !applet._scanBusy) {
                unwatch();
                this._sawPopup = true;   // something popped up, so the click did have an effect
                applet.gtkBridge.scan(this.pid, (res, err) => {
                    if (this.destroyed) {
                        hider.reveal();
                        return;
                    }
                    if (res && res.items && res.items.length > 0) {
                        /* Only now is it certain that a left click shows a menu */
                        this.primaryIsMenu = true;
                        this._primaryVerified = true;
                        this.lastButton = 1;
                        applet.markLearned(this.stableId() + "#menu3");
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
                unwatch();
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
        this.applet.forgetLearned(this.stableId() + "#menu3");
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
        let cached = (button === 1 && !this._primaryVerified) ? null : this.applet.cachedMenu(this.stableId(), button);
        if (cached) {
            this.gtkItems = cached.items;
            this.gtkEpoch = cached.epoch;
            cb(true);
            return;
        }
        this.whenReleased(() => {
            this.scanNative(() => this.synthClick(button, this.lastEventTime), (ok) => {
                if (ok && button === 1 && this.gtkItems)
                    this._primaryVerified = true;
                cb(ok);
            }, { button: button, onNoPopup: this._noPopupHandler(button) });
        });
    }

    /* Called when a menu of this entry was closed: update the stored copy for the next opening */
    scheduleRefresh(retries, delay) {
        if (this.destroyed || !this.canTranslateNative() || this._refreshTimer)
            return;
        this._refreshTimer = Mainloop.timeout_add(delay || 500, () => {
            this._refreshTimer = 0;
            this.refreshNative(retries || 0);
            return false;
        });
    }

    refreshNative(retries) {
        if (this.destroyed || !this.canTranslateNative())
            return;
        let applet = this.applet;
        /* Not while a menu is open, a button is held, another reading runs, the icon was just clicked, or the
         * user is working in the application (a stray key press must never reach its window) */
        if (applet.menu.isOpen || applet.pointerButtonsDown() || applet._scanBusy ||
            GLib.get_monotonic_time() < this._clickBusyUntil || this.windowMatches(global.display.focus_window)) {
            if (retries < 8)
                this.scheduleRefresh(retries + 1, 700);
            return;
        }
        /* Never "click" the icon's primary action in the background unless its menu was read that way this session */
        let button = (this.primaryIsMenu && this.lastButton === 1 && this._primaryVerified &&
            applet.cachedMenu(this.stableId(), 1)) ? 1 : 3;
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
        let added = false;
        if (this.applet.showOpenEntry && !this.primaryIsMenu && !this.openSuppressed()) {
            this.addOpenItem(menu, () => {
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
            source.populate(menu);
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
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            if (etype === Clutter.EventType.BUTTON_PRESS)
                this.applet.noteContextEntry(this);
            return false;
        }

        if (etype === Clutter.EventType.BUTTON_PRESS) {
            this._lastPressAt = GLib.get_monotonic_time();
            this.applet.noteActivity(this);
        } else if (etype === Clutter.EventType.SCROLL) {
            this.applet.noteActivity(this);
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

    /*
     * A click repeated from the hidden icons menu: build the button events the icon would have received
     * and hand them to the icon like _onTrayEvent does. Best effort - if it fails, the icon is still back
     * in the panel and the user simply clicks it again.
     */
    synthClick(button, time) {
        let icon = this.trayIcon;
        let t = time || global.get_current_time();
        let send = (type) => {
            try {
                let [x, y] = icon.get_transformed_position();
                let [w, h] = icon.get_transformed_size();
                let ev = Clutter.Event.new(type);
                ev.set_button(button);
                ev.set_coords(x + w / 2, y + h / 2);
                ev.set_time(t);
                ev.set_stage(global.stage);
                ev.set_source(icon);
                icon.handle_event(type, ev);
            } catch (e) {
                warn("could not repeat the click on legacy tray icon " + this.role, e);
            }
        };
        send(Clutter.EventType.BUTTON_PRESS);
        Mainloop.timeout_add(60, () => {
            if (!this.destroyed)
                send(Clutter.EventType.BUTTON_RELEASE);
            return false;
        });
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
        this._loadAutohide();

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
        this._stage("overflow button", () => this._createOverflowButton());

        this._stage("settings", () => this._bindSettings(metadata, instanceId));
        this._stage("menu", () => this._createMenu());
        this._stage("autohide", () => {
            this._createKeepMenu();
            this._syncAutohideTimer();
        });

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

        /* The legacy tray starts in on_applet_added_to_panel(): manage_screen() reads the theme of
         * this.actor, which only works once the actor is on the stage */
        if (this.actor.get_stage())
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
            ["learned-no-open", "learnedNoOpen"], ["icon-order", "iconOrder"],
            ["autohide-enabled", "autohideEnabled"], ["autohide-hours", "autohideHours"],
            ["autohide-button-position", "autohideButtonPosition"], ["autohide-menu-items", "autohideMenuItems"],
            ["autohide-visit-minutes", "autohideVisitMinutes"]
        ])
            this.settings.bind(key, prop, cb);
    }

    /* "Open <application>" entries belong to the "Show the menu" mode of the left-click setting */
    get showOpenEntry() {
        return this.leftClickAction !== "activate";
    }

    _onSettingsChanged() {
        this._syncAutohideTimer();
        if (!this.autohideEnabled && this.overflowMenu)
            this.overflowMenu.close(false);
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
        this._updateOverflowIcon();
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
        if (this.overflowMenu)
            this.overflowMenu.close(false);
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
        this._destroyOverflowMenu();
        if (this._overflowTooltip)
            this._overflowTooltip.orientation = orientation;
        this.refreshIcons();
    }

    on_applet_added_to_panel() {
        this._stage("legacy tray", () => this._startLegacy());
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
        /* Icons sitting in the hidden icons menu are skipped; the hidden icons button goes first or last */
        let index = this._overflowAtStart() ? 1 : 0;
        for (let entry of list) {
            if (entry.actor.get_parent() === this.manager_container)
                this.manager_container.set_child_at_index(entry.actor, index++);
        }
        this._placeOverflowButton();
    }

    _overflowAtStart() {
        return this.autohideButtonPosition === "start" && !!this.overflowButton &&
            this.overflowButton.get_parent() === this.manager_container;
    }

    /* The hidden icons button sits after the icons (bottom / right) unless the setting says before */
    _placeOverflowButton() {
        let button = this.overflowButton;
        if (!button || button.get_parent() !== this.manager_container)
            return;
        let last = this.manager_container.get_n_children() - 1;
        this.manager_container.set_child_at_index(button, this.autohideButtonPosition === "start" ? 0 : last);
    }

    /* ---- reordering by drag and drop (panel edit mode, Shift/Ctrl + drag) ---- */
    dragBegan(entry) {
        this.menu.close(false);
        if (this.overflowMenu)
            this.overflowMenu.close(false);
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
        let others = this.manager_container.get_children().filter(a => a !== source.actor && a !== this.overflowButton);
        let before = others.find(a => {
            if (!a.visible)
                return false;
            let [ax, ay] = a.get_position();
            let [aw, ah] = a.get_size();
            return pos < (vertical ? ay + ah / 2 : ax + aw / 2);
        });
        others.splice(before ? others.indexOf(before) : others.length, 0, source.actor);
        let offset = this._overflowAtStart() ? 1 : 0;
        others.forEach((a, i) => this.manager_container.set_child_at_index(a, i + offset));
        this._placeOverflowButton();
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
            highlightSource(m, open);
            if (m !== this.menu)
                return;
            if (!open) {
                let closedEntry = this.menuEntry;
                this.menuEntry = null;
                this.menuToken++;
                this._menuClosedAt = Clutter.get_current_event_time();
                if (closedEntry && typeof closedEntry.scheduleRefresh === "function")
                    closedEntry.scheduleRefresh(0, this._closedByActivation ? 3000 : 500);
                this._closedByActivation = false;
            }
        });
    }

    /*
     * If a menu is open (or was closed by this very click's press), the click only closes it and the
     * matching release is ignored - exactly how clicking another panel applet behaves.
     */
    consumeClickIfMenuOpen(event) {
        let t = event.get_time();
        let recently = (at) => !!at && Math.abs(t - at) < 50;
        let overflowOpen = !!this.overflowMenu && this.overflowMenu.isOpen;
        let wasOpen = this.menu.isOpen || overflowOpen || recently(this._menuClosedAt) ||
            recently(this._overflowClosedAt);
        if (!wasOpen)
            return false;
        if (this.menu.isOpen)
            this.menu.close(true);
        if (overflowOpen)
            this.overflowMenu.close(true);
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
        /*
         * Rebuilding an open menu (the application changed it, e.g. after a switch was flipped)
         * destroys the item that has the key focus. Cinnamon's menu manager closes a menu whose
         * focus goes elsewhere, so park the focus on the menu itself and give it back afterwards.
         */
        let refocus = -1;
        let scrollPos = 0;
        if (this.menu.isOpen) {
            try {
                let focus = global.stage.key_focus;
                if (focus && this._menuSection)
                    refocus = this._menuSection._getMenuItems().findIndex(it => it.actor && it.actor.contains(focus));
                if (this._menuScroll)
                    scrollPos = this._menuScroll.get_vscroll_bar().get_adjustment().value;
            } catch (e) { /* only cosmetic */ }
            this.menu.actor.grab_key_focus();
        }
        this._menuSection = null;
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
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);   // see _updateMenuScrollbar()
        this._menuMaxHeight = this._maxMenuHeight(entry);
        scroll.style = "max-height: " + this._menuMaxHeight + "px;";
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
        this._addAutohideItems(section, entry);
        this._watchSubmenus(section, scroll);
        this._menuSection = section;

        if (refocus >= 0 || scrollPos > 0) {
            /* After the new items are laid out: same scroll position, same item highlighted */
            Mainloop.idle_add(() => {
                if (this._menuSection !== section || !this.menu.isOpen)
                    return false;
                try {
                    if (scrollPos > 0)
                        scroll.get_vscroll_bar().get_adjustment().value = scrollPos;
                    let item = refocus >= 0 ? section._getMenuItems()[refocus] : null;
                    if (item && item.actor && item.actor.reactive)
                        item.actor.grab_key_focus();
                } catch (e) { /* only cosmetic */ }
                return false;
            });
        }
    }

    /* Opening or closing a submenu changes the menu's height: it may need its scrollbar then, or no more */
    _watchSubmenus(section, scroll) {
        let walk = (menu) => {
            let items = [];
            try {
                items = menu._getMenuItems();
            } catch (e) { /* not a menu */ }
            for (let item of items) {
                if (item && item.menu instanceof PopupMenu.PopupSubMenu) {
                    item.menu.connect("open-state-changed", () => {
                        Mainloop.idle_add(() => {
                            if (this._menuScroll === scroll)
                                this._updateMenuScrollbar(scroll, section);
                            return false;
                        });
                    });
                    walk(item.menu);
                }
            }
        };
        walk(section);
        this._updateMenuScrollbar(scroll, section);
    }

    /*
     * The scroll view keeps room for an automatic scrollbar even while it is hidden, which left an empty
     * strip on the right of every menu: the scrollbar is only turned on when the items don't fit (as
     * Cinnamon does for its submenus).
     */
    _updateMenuScrollbar(scroll, section) {
        try {
            let [, natural] = section.actor.get_preferred_height(-1);
            let max = (this._menuMaxHeight || 600) * global.ui_scale;
            let policy = natural > max ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
            if (scroll.vscrollbar_policy !== policy)
                scroll.set_policy(St.PolicyType.NEVER, policy);
        } catch (e) { /* keep the current policy */ }
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
        let client = entry.menuClient;
        let before = client.layout ? client.shapeKey() : null;
        client.fetch((changed) => {
            if (this.menuEntry !== entry || !this.menu.isOpen)
                return;
            /* Only toggle states changed (e.g. a switch was flipped): update the items in place */
            if (before !== null && client.shapeKey() === before && client.applyToggleStates())
                return;
            if (changed)
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

    /* ---- hiding icons that have not been used for a while ---- */
    /*
     * this.autohide.clock counts the seconds the session has been in use: time asleep, or with nobody at
     * the keyboard, doesn't count, so a weekend away doesn't hide everything. Each icon remembers the clock
     * value of its last use ("used"); an icon not used for the configured time is shown only in the hidden
     * icons menu (the arrow button in front of the icons). Icons are identified by orderKey(), the same key
     * the saved icon order uses. "pin" keeps an icon in the panel for good.
     */
    _autohidePath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), "unified-tray", "autohide.json"]);
    }

    _today() {
        return Math.floor(GLib.get_real_time() / 86400e6);
    }

    _loadAutohide() {
        this.autohide = { clock: 0, icons: {} };
        this._autohideDirty = false;
        try {
            let [ok, data] = GLib.file_get_contents(this._autohidePath());
            if (!ok)
                return;
            let obj = JSON.parse(bytesToString(data));
            if (!obj || typeof obj.clock !== "number" || !obj.icons || typeof obj.icons !== "object")
                return;
            let today = this._today();
            for (let [key, rec] of Object.entries(obj.icons)) {
                if (!rec || typeof rec.used !== "number")
                    continue;
                if (!rec.pin && typeof rec.day === "number" && today - rec.day > AUTOHIDE_FORGET_DAYS) {
                    this._autohideDirty = true;   // not seen for months: forget it
                    continue;
                }
                this.autohide.icons[key] = rec;
            }
            this.autohide.clock = obj.clock;
        } catch (e) { /* nothing stored yet */ }
    }

    _saveAutohide() {
        if (!this._autohideDirty || !this.autohide)
            return;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._autohidePath()), 0o755);
            GLib.file_set_contents(this._autohidePath(), JSON.stringify(this.autohide));
            this._autohideDirty = false;
        } catch (e) {
            warn("could not store which icons are in use", e);
        }
    }

    _autohideLimit() {
        let hours = Number(this.autohideHours);
        return (hours > 0 ? hours : 24) * 3600;
    }

    /* What is known about an entry; an icon seen for the first time counts as just used */
    _autohideRecord(entry) {
        let key = entry.orderKey();
        let rec = this.autohide.icons[key];
        if (!rec) {
            rec = { used: this.autohide.clock };
            this.autohide.icons[key] = rec;
            this._autohideDirty = true;
        }
        let today = this._today();
        if (rec.day !== today) {
            rec.day = today;
            this._autohideDirty = true;
        }
        return rec;
    }

    /* The pointer is on the icon or its menu is open: it must not be pulled away now */
    _entryBusy(entry) {
        if (this.menuEntry === entry && this.menu && this.menu.isOpen)
            return true;
        try {
            return !!entry.actor.hover;
        } catch (e) {
            return false;
        }
    }

    /*
     * The pointer is anywhere on the tray, or one of its menus is open: icons are not hidden by the timeout
     * now, as the remaining ones would shift and the icon under the pointer move away. They are hidden at
     * the next check once the pointer has left. (Hiding by hand happens right away.)
     */
    _trayBusy() {
        if ((this.menu && this.menu.isOpen) || (this.overflowMenu && this.overflowMenu.isOpen))
            return true;
        try {
            let [px, py] = global.get_pointer();
            let [x, y] = this.actor.get_transformed_position();
            let [w, h] = this.actor.get_transformed_size();
            return px >= x && px < x + w && py >= y && py < y + h;
        } catch (e) {
            return false;
        }
    }

    /* Called by updateVisibility() for icons that are shown */
    isAutoHidden(entry) {
        if (!this.autohideEnabled || !this.autohide || entry.destroyed)
            return false;
        let rec = this._autohideRecord(entry);
        if (rec.pin)
            return false;
        if (entry._tempVisit)
            return false;   // shown for a click made in the hidden icons menu
        if (rec.shownUntil) {
            if (this.autohide.clock < rec.shownUntil)
                return false;   // shown for a while after being used from the hidden icons menu
            delete rec.shownUntil;
            this._autohideDirty = true;
        }
        /* Hidden by hand (stays hidden until used), or not used for the configured time */
        let due = !!rec.forced || this.autohide.clock - rec.used >= this._autohideLimit();
        if (!due)
            return false;
        if (entry.autoHidden || entry._hidingNow)
            return true;    // already hidden, or "Hide now" was chosen this very moment
        /* Otherwise not while the pointer is on the tray or a menu is open (see _trayBusy) */
        return !(this._entryBusy(entry) || this._trayBusy());
    }

    /*
     * A "Tray icon" submenu ("Move to hidden icons" - or "Keep in the panel" for an icon only visiting the
     * panel - and "Pin to the panel") at the bottom of an icon's own
     * (translated) menu, below a separator, so these read as the tray's options, not the application's.
     * Menus the applications draw themselves can't get it: Ctrl+right click offers the same there.
     */
    _addAutohideItems(section, entry) {
        if (!this.autohideEnabled || !this.autohideMenuItems || entry.destroyed || !entry.computeVisible() ||
            this.isUserHidden(entry))
            return;
        let pinned = !!this._autohideRecord(entry).pin;
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let sub = new PopupMenu.PopupSubMenuMenuItem(_("Tray icon"));
        /* Built like the application's own items (makeMenuItem), so icons, switches and padding line up */
        let symbolic = (name) => new St.Icon({
            icon_name: name,
            icon_type: St.IconType.SYMBOLIC,
            icon_size: MENU_ICON_SIZE
        });
        if (this.isVisiting(entry)) {
            let back = makeMenuItem(_("Keep in the panel"), symbolic("view-reveal-symbolic"), null, null);
            back.connect("activate", () => this.moveToPanel(entry));
            sub.menu.addMenuItem(back);
        } else if (!entry.autoHidden) {
            let hide = makeMenuItem(_("Move to hidden icons"), symbolic("view-conceal-symbolic"), null, null);
            hide.connect("activate", () => this.hideNow(entry));
            sub.menu.addMenuItem(hide);
        }
        /* A switch: flipping it leaves the menu open, like the application's own switches */
        let keep = makeMenuItem(_("Pin to the panel"), null, null, { switchState: pinned, keepMenu: true });
        keep.connect("activate", () => this.setPinned(entry, keep._switch.state));
        sub.menu.addMenuItem(keep);
        section.addMenuItem(sub);
    }

    /* The user clicked or scrolled on an icon */
    noteActivity(entry) {
        if (!this.autohideEnabled || !this.autohide || entry.destroyed)
            return;
        if (this.isVisiting(entry)) {
            /*
             * Using an icon that is only visiting the panel doesn't bring it back; a visit for a set time
             * starts its minutes over, so the icon only leaves once it hasn't been used for that long.
             */
            let rec = this.autohide.icons[entry.orderKey()];
            let minutes = Number(this.autohideVisitMinutes);
            if (!entry._tempVisit && rec && rec.shownUntil && minutes > 0) {
                rec.shownUntil = Math.max(rec.shownUntil, this.autohide.clock + minutes * 60);
                this._autohideDirty = true;
            }
            return;
        }
        let rec = this._autohideRecord(entry);
        rec.used = this.autohide.clock;
        delete rec.forced;
        this._autohideDirty = true;
        if (entry.autoHidden)
            entry.updateVisibility();
    }

    /* True while a hidden icon is only visiting the panel (for a click, or for a while) */
    isVisiting(entry) {
        if (entry._tempVisit)
            return true;
        let rec = this.autohide ? this.autohide.icons[entry.orderKey()] : null;
        return !!(rec && rec.shownUntil && this.autohide.clock < rec.shownUntil);
    }

    /* Used from the hidden icons menu with a time set: the icon stays in the panel for that many minutes of use */
    _showForAWhile(entry) {
        this._endTempVisit(entry, true);
        let minutes = Number(this.autohideVisitMinutes);
        let rec = this._autohideRecord(entry);
        rec.shownUntil = this.autohide.clock + (minutes > 0 ? minutes : 30) * 60;
        this._autohideDirty = true;
        this._saveAutohide();
        entry.updateVisibility();
    }

    _clearVisit(entry) {
        this._endTempVisit(entry, true);
        let rec = this.autohide ? this.autohide.icons[entry.orderKey()] : null;
        if (rec && rec.shownUntil) {
            delete rec.shownUntil;
            this._autohideDirty = true;
        }
    }

    /* Back to the panel for good (not pinned: the icon starts a fresh period, as if it was just used) */
    moveToPanel(entry) {
        this._clearVisit(entry);
        this.noteActivity(entry);
        entry.updateVisibility();
    }

    /*
     * Used from the hidden icons menu with 0 minutes set: the icon appears in the panel for the click made in
     * the hidden icons menu without counting as used. It goes back once nothing of it is in use any more:
     * no menu of ours for it (being prepared or open), no popup window of its process (the application's
     * own menu), the pointer not on it - checked twice a second, after a short grace period for menus
     * and popups to appear.
     */
    _startTempVisit(entry) {
        this._endTempVisit(entry, true);
        let visit = { start: GLib.get_monotonic_time(), popups: new Set(), mapId: 0, timer: 0 };
        entry._tempVisit = visit;
        if (entry.pid) {
            try {
                visit.mapId = global.window_manager.connect("map", (wm, actor) => {
                    try {
                        let win = actor.meta_window;
                        if (win && win.get_pid() === entry.pid && win.is_override_redirect()) {
                            visit.popups.add(actor);
                            actor.connect("destroy", () => visit.popups.delete(actor));
                        }
                    } catch (e) { /* ignore */ }
                });
            } catch (e) {
                visit.mapId = 0;
            }
        }
        visit.timer = Mainloop.timeout_add(500, () => {
            if (entry._tempVisit === visit && !entry.destroyed && this._tempVisitBusy(entry, visit))
                return true;
            visit.timer = 0;
            if (entry._tempVisit === visit)
                this._endTempVisit(entry);
            return false;
        });
        entry.updateVisibility();
    }

    _tempVisitBusy(entry, visit) {
        if (GLib.get_monotonic_time() - visit.start < 1500e3)
            return true;
        if (this.menuEntry === entry)
            return true;
        if (visit.popups.size > 0)
            return true;
        /* Ends with the pointer off the tray; isAutoHidden() would keep it shown till then anyway */
        return this._trayBusy();
    }

    _endTempVisit(entry, quiet) {
        let visit = entry._tempVisit;
        if (!visit)
            return;
        entry._tempVisit = null;
        if (visit.mapId) {
            global.window_manager.disconnect(visit.mapId);
            visit.mapId = 0;
        }
        if (visit.timer) {
            Mainloop.source_remove(visit.timer);
            visit.timer = 0;
        }
        visit.popups.clear();
        if (!quiet && !entry.destroyed)
            entry.updateVisibility();
    }

    /* Move an icon to the hidden icons menu right away; it comes back like any hidden icon, when used */
    hideNow(entry) {
        if (entry.destroyed || !this.autohideEnabled)
            return;
        this._clearVisit(entry);
        let rec = this._autohideRecord(entry);
        delete rec.pin;
        rec.forced = true;
        this._autohideDirty = true;
        this._saveAutohide();
        entry._hidingNow = true;
        try {
            entry.updateVisibility();
        } finally {
            entry._hidingNow = false;
        }
    }

    /* The icon a Ctrl+right click (which opens the context menu) was made on */
    noteContextEntry(entry) {
        this._contextEntry = { entry: entry, at: GLib.get_monotonic_time() };
    }

    /* Keep an icon in the panel for good, or let it be hidden again (it then starts a fresh period) */
    setPinned(entry, pinned) {
        if (entry.destroyed)
            return;
        this._clearVisit(entry);
        let rec = this._autohideRecord(entry);
        delete rec.forced;
        if (pinned) {
            rec.pin = true;
        } else {
            delete rec.pin;
            rec.used = this.autohide.clock;
        }
        this._autohideDirty = true;
        this._saveAutohide();
        entry.updateVisibility();
    }

    /* Settings button */
    on_autohide_show_all() {
        for (let rec of Object.values(this.autohide.icons)) {
            rec.used = this.autohide.clock;
            delete rec.forced;
            delete rec.shownUntil;
        }
        this._autohideDirty = true;
        this._saveAutohide();
        for (let entry of this.entries.values())
            entry.updateVisibility();
    }

    _syncAutohideTimer() {
        let want = !!this.autohideEnabled && !this._shuttingDown;
        if (want && !this._autohideTimer) {
            this._autohideLast = GLib.get_monotonic_time();
            this._autohideTicks = 0;
            this._autohideTimer = Mainloop.timeout_add_seconds(AUTOHIDE_TICK, () => {
                try {
                    this._autohideTick();
                } catch (e) {
                    warn("checking for unused icons failed", e);
                }
                return true;
            });
        } else if (!want && this._autohideTimer) {
            Mainloop.source_remove(this._autohideTimer);
            this._autohideTimer = 0;
            this._saveAutohide();
        }
    }

    /* Seconds since the last keyboard or mouse input (0 if this can't be found out: the time then counts) */
    _userIdleSeconds() {
        try {
            return Meta.IdleMonitor.get_core().get_idletime() / 1000;
        } catch (e) {
            return 0;
        }
    }

    _autohideTick() {
        let now = GLib.get_monotonic_time();
        /* The monotonic clock stands still while suspended; a late tick never counts for more than two */
        let elapsed = Math.min(Math.max(0, (now - this._autohideLast) / 1e6), 2 * AUTOHIDE_TICK);
        this._autohideLast = now;
        if (this._userIdleSeconds() < AUTOHIDE_IDLE_LIMIT) {
            this.autohide.clock += Math.round(elapsed);
            this._autohideDirty = true;
        }
        for (let entry of this.entries.values())
            entry.updateVisibility();
        if (++this._autohideTicks % 10 === 0)
            this._saveAutohide();
    }

    /* ---- the hidden icons button and its menu ---- */
    _createOverflowButton() {
        let button = new St.BoxLayout({
            style_class: "applet-box",
            reactive: true,
            track_hover: true,
            visible: false,
            x_expand: true,
            y_expand: true
        });
        this.overflowIcon = new St.Icon({ icon_type: St.IconType.SYMBOLIC, y_align: Clutter.ActorAlign.CENTER });
        button.add_actor(this.overflowIcon);
        this._overflowTooltip = new Tooltips.PanelItemTooltip({ actor: button }, _("Hidden icons"), this.orientation);
        button.connect("button-press-event", (a, event) => this._onOverflowPress(event));
        button.connect("button-release-event", (a, event) => {
            if (global.settings.get_boolean("panel-edit-mode") || event.get_button() !== Clutter.BUTTON_PRIMARY)
                return EVENT_PROPAGATE;
            return EVENT_STOP;
        });
        this.overflowButton = button;
        this.manager_container.insert_child_at_index(button, 0);
        this._updateOverflowIcon();
    }

    /* The arrow points to where the menu opens */
    _updateOverflowIcon() {
        if (!this.overflowIcon)
            return;
        let name;
        switch (this.orientation) {
            case St.Side.TOP:
                name = "pan-down-symbolic";
                break;
            case St.Side.LEFT:
                name = "pan-end-symbolic";
                break;
            case St.Side.RIGHT:
                name = "pan-start-symbolic";
                break;
            default:
                name = "pan-up-symbolic";
        }
        this.overflowIcon.icon_name = name;
        this.overflowIcon.icon_size = this.getPanelIconSize(St.IconType.SYMBOLIC);
    }

    /* The button is shown while at least one icon is hidden */
    updateOverflowButton() {
        if (!this.overflowButton)
            return;
        let any = false;
        if (this.autohideEnabled) {
            for (let e of this.entries.values()) {
                if (e.autoHidden && !e.destroyed) {
                    any = true;
                    break;
                }
            }
        }
        this.overflowButton.visible = any;
    }

    /* Left click toggles the menu; right click falls through to the applet's own context menu */
    _onOverflowPress(event) {
        if (this._overflowTooltip)
            this._overflowTooltip.hide();
        if (global.settings.get_boolean("panel-edit-mode") || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return EVENT_PROPAGATE;
        if (this.consumeClickIfMenuOpen(event))
            return EVENT_STOP;
        this.openOverflow();
        return EVENT_STOP;
    }

    _newOverflowMenu() {
        this._destroyOverflowMenu();
        let menu = new Applet.AppletPopupMenu(this, this.orientation);
        menu.sourceActor = this.overflowButton;
        /*
         * A manager of its own: in a shared one, moving the pointer from this menu back over the applet
         * (the source of the icon menu) makes the manager switch to the icon menu, which is empty then.
         */
        if (!this.overflowMenuManager)
            this.overflowMenuManager = new PopupMenu.PopupMenuManager(this);
        this.overflowMenuManager.addMenu(menu);
        menu.connect("open-state-changed", (m, open) => {
            highlightSource(m, open);
            if (m === this.overflowMenu && !open)
                this._onOverflowClosed();
        });
        this.overflowMenu = menu;
    }

    _destroyOverflowMenu() {
        let old = this.overflowMenu;
        if (!old)
            return;
        try {
            old.close(false);   // hands the icons back to the panel first
        } catch (e) { /* ignore */ }
        this._finishOverflowClose();
        this.overflowMenu = null;
        try {
            this.overflowMenuManager.removeMenu(old);
            old.destroy();
        } catch (e) {
            warn("could not dispose the hidden icons menu", e);
        }
    }

    /*
     * The real icons move into the menu while it is open (so they keep updating), in the panel order.
     * There they are pictures only: the menu item takes the click, the menu closes, the icon goes back to
     * the panel (it was used) and the click is repeated on it there.
     */
    openOverflow() {
        let hidden = this.manager_container.get_children()
            .map(a => a._delegate)
            .filter(e => e instanceof TrayEntry && e.autoHidden && !e.destroyed);
        if (hidden.length === 0)
            return;
        if (this.menu.isOpen)
            this.menu.close(false);
        this._newOverflowMenu();
        this._overflowPending = null;
        this._overflowMoved = [];
        for (let entry of hidden) {
            try {
                this.overflowMenu.addMenuItem(this._makeOverflowItem(entry));
            } catch (e) {
                warn("could not add " + entry.displayName() + " to the hidden icons menu", e);
            }
        }
        this.overflowMenu.open(true);
    }

    _makeOverflowItem(entry) {
        let item = new PopupMenu.PopupBaseMenuItem();
        /* A plain box, not an St.Bin: St.Bin tracks its child privately and asserts (crashing Cinnamon)
         * when it is destroyed after the child was taken out with remove_child() */
        let holder = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._moveIntoOverflow(entry, holder);
        item.addActor(holder, { expand: false });

        let label = new St.Label({ text: entry.displayName(), y_align: Clutter.ActorAlign.CENTER });
        item.addActor(label, { expand: true });

        /* Small buttons at the end of the row; each closes the menu and acts once the icon is back */
        let addButton = (iconNames, tip, pending) => {
            let button = new St.Button({
                reactive: true,
                can_focus: false,
                style_class: "unified-tray-pin",
                child: new St.Icon({
                    gicon: Gio.ThemedIcon.new_from_names(iconNames),
                    icon_type: St.IconType.SYMBOLIC,
                    icon_size: MENU_ICON_SIZE
                })
            });
            let tooltip = new MenuButtonTooltip(button, tip, this.orientation);
            button.connect("destroy", () => {
                try {
                    tooltip.destroy();
                } catch (e) { /* already gone */ }
            });
            button.connect("clicked", () => {
                if (this._overflowPending)
                    return;
                this._overflowPending = Object.assign({ entry: entry, button: 0 }, pending);
                if (this.overflowMenu)
                    this.overflowMenu.close(true);
            });
            item.addActor(button, { expand: false, align: St.Align.END });
        };
        /* Using an icon here only shows it for a while, so moving it back for good needs a button of its own */
        let hours = Number(this.autohideHours) > 0 ? Number(this.autohideHours) : 24;
        addButton(["view-reveal-symbolic", "go-up-symbolic"],
            _("Move to the panel") + "\n" + (hours === 1 ? _("Hides again after 1 hour without use") :
                _("Hides again after %d hours without use").replace("%d", String(hours))),
            { restore: true });
        addButton(["view-pin-symbolic", "emblem-favorite-symbolic"], _("Pin to the panel"), { pin: true });

        /* Connected before the menu's own handler (addMenuItem), so this runs before the menu closes */
        item.connect("activate", (it, event) => {
            if (this._overflowPending)
                return;
            let button = Clutter.BUTTON_PRIMARY;
            try {
                let t = event ? event.type() : null;
                if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.BUTTON_RELEASE)
                    button = event.get_button();
            } catch (e) { /* keyboard: primary */ }
            this._overflowPending = { entry: entry, button: button };
        });
        return item;
    }

    _moveIntoOverflow(entry, holder) {
        let actor = entry.actor;
        entry._overflowSaved = {
            reactive: actor.reactive,
            trackHover: actor.track_hover,
            iconReactive: entry.trayIcon ? entry.trayIcon.reactive : null
        };
        if (entry._tooltip)
            entry._tooltip.hide();
        actor.remove_style_pseudo_class("hover");
        actor.reactive = false;
        actor.track_hover = false;
        if (entry.trayIcon)
            entry.trayIcon.reactive = false;
        this.manager_container.remove_child(actor);
        holder.add_child(actor);
        entry.inOverflow = true;
        this._overflowMoved.push(entry);
        entry.updateVisibility();
    }

    /*
     * The menu still animates out after "closed" is signalled; the icons stay in it until it is hidden,
     * otherwise it shrinks while fading. _finishOverflowClose() can also be called early (the menu is
     * rebuilt or destroyed, an icon in it goes away) and then runs right away, once.
     */
    _onOverflowClosed() {
        this._overflowClosedAt = Clutter.get_current_event_time();
        this._finishOverflowClose();   // a close still waiting for its animation
        let actor = this.overflowMenu ? this.overflowMenu.actor : null;
        if (!actor || !actor.visible) {
            this._overflowCloseWait = { cancel: () => {} };
            this._finishOverflowClose();
            return;
        }
        let signalId = 0;
        let timer = 0;
        let cancel = () => {
            if (signalId) {
                actor.disconnect(signalId);
                signalId = 0;
            }
            if (timer) {
                Mainloop.source_remove(timer);
                timer = 0;
            }
        };
        this._overflowCloseWait = { cancel: cancel };
        signalId = actor.connect("notify::visible", () => {
            if (!actor.visible)
                this._finishOverflowClose();
        });
        timer = Mainloop.timeout_add(600, () => {   // in case the menu is never hidden
            timer = 0;
            this._finishOverflowClose();
            return false;
        });
    }

    _finishOverflowClose() {
        let wait = this._overflowCloseWait;
        if (!wait)
            return;
        this._overflowCloseWait = null;
        wait.cancel();
        let moved = this._overflowMoved || [];
        this._overflowMoved = [];
        for (let entry of moved) {
            entry.inOverflow = false;
            if (entry.destroyed)
                continue;
            try {
                let actor = entry.actor;
                let holder = actor.get_parent();
                if (holder)
                    holder.remove_child(actor);
                this.manager_container.add_child(actor);
                let saved = entry._overflowSaved || {};
                actor.reactive = saved.reactive !== false;
                actor.track_hover = saved.trackHover !== false;
                if (entry.trayIcon && typeof saved.iconReactive === "boolean")
                    entry.trayIcon.reactive = saved.iconReactive;
                entry.updateVisibility();
            } catch (e) {
                warn("could not give " + entry.displayName() + " back to the panel", e);
            }
        }
        this.sortEntries();

        let pending = this._overflowPending;
        this._overflowPending = null;
        if (!pending || pending.entry.destroyed)
            return;
        let entry = pending.entry;
        if (pending.pin)
            this.setPinned(entry, true);
        else if (pending.restore)
            this.moveToPanel(entry);
        else if (Number(this.autohideVisitMinutes) > 0)
            this._showForAWhile(entry);
        else
            this._startTempVisit(entry);   // 0 minutes: only while it is in use
        if (pending.button) {
            /* Wait until the icon has its place in the panel and the menu's grab is gone */
            Mainloop.timeout_add(150, () => {
                if (!entry.destroyed && entry.actor.visible && entry.actor.get_parent() === this.manager_container)
                    entry.replayClick(pending.button);
                return false;
            });
        }
    }

    /*
     * In the applet's context menu (right click the hidden icons button, or Ctrl+right click any icon):
     *   "Hide <app> now",
     *   "Pin <app> to the panel"  - only after a Ctrl+right click on an icon in the panel
     *                               (the first one reads "Keep <app> in the panel" for an icon only visiting)
     *   "Move to hidden icons"    - hide any icon in the panel right away
     *   "Pin to the panel"        - pin icons so they are never hidden
     */
    _createKeepMenu() {
        let ctx = this._applet_context_menu;
        if (!ctx)
            return;
        this._hideNowItem = new PopupMenu.PopupIconMenuItem("", "view-conceal-symbolic", St.IconType.SYMBOLIC);
        this._hideNowItem.connect("activate", () => {
            let entry = this._hideNowEntry;
            if (!entry)
                return;
            if (this.isVisiting(entry))
                this.moveToPanel(entry);
            else
                this.hideNow(entry);
        });
        ctx.addMenuItem(this._hideNowItem);
        this._pinNowItem = new PopupMenu.PopupSwitchMenuItem("", false);
        this._pinNowItem.connect("toggled", (it, state) => {
            if (this._hideNowEntry)
                this.setPinned(this._hideNowEntry, state);
        });
        ctx.addMenuItem(this._pinNowItem);
        this._hideItem = new PopupMenu.PopupSubMenuMenuItem(_("Move to hidden icons"));
        ctx.addMenuItem(this._hideItem);
        this._keepItem = new PopupMenu.PopupSubMenuMenuItem(_("Pin to the panel"));
        ctx.addMenuItem(this._keepItem);
        this._keepSeparator = new PopupMenu.PopupSeparatorMenuItem();
        ctx.addMenuItem(this._keepSeparator);
        ctx.connect("open-state-changed", (m, open) => {
            if (open)
                this._fillKeepMenu();
            else
                this._contextEntry = null;
        });
        this._fillKeepMenu();
    }

    _fillKeepMenu() {
        if (!this._keepItem)
            return;
        let show = !!this.autohideEnabled;
        let list = show ? Array.from(this.entries.values())
            .filter(e => !e.destroyed && e.computeVisible() && !this.isUserHidden(e)) : [];
        list.sort((a, b) => GLib.utf8_collate(a.displayName(), b.displayName()));

        /* "Hide <app> now", for the icon this menu was opened from (Ctrl+right click within the last seconds) */
        let ctxEntry = null;
        let c = this._contextEntry;
        if (show && c && GLib.get_monotonic_time() - c.at < 3e6 && list.indexOf(c.entry) >= 0 && !c.entry.autoHidden)
            ctxEntry = c.entry;
        this._hideNowEntry = ctxEntry;
        this._hideNowItem.actor.visible = !!ctxEntry;
        this._pinNowItem.actor.visible = !!ctxEntry;
        if (ctxEntry) {
            let name = ctxEntry.displayName();
            this._hideNowItem.label.set_text((this.isVisiting(ctxEntry) ? _("Keep %s in the panel") : _("Hide %s now"))
                .replace("%s", name));
            this._pinNowItem.label.set_text(_("Pin %s to the panel").replace("%s", name));
            this._pinNowItem.setToggleState(!!this._autohideRecord(ctxEntry).pin);
        }

        /* "Move to hidden icons": the icons that are in the panel now */
        this._hideItem.menu.removeAll();
        let inPanel = list.filter(e => !e.autoHidden);
        this._hideItem.actor.visible = show && inPanel.length > 0;
        for (let entry of inPanel) {
            let item = new PopupMenu.PopupMenuItem(entry.displayName());
            item.connect("activate", () => this.hideNow(entry));
            this._hideItem.menu.addMenuItem(item);
        }

        this._keepItem.actor.visible = show;
        this._keepSeparator.actor.visible = show;
        this._keepItem.menu.removeAll();
        if (!show)
            return;
        for (let entry of list) {
            let rec = this._autohideRecord(entry);
            let item = new PopupMenu.PopupSwitchMenuItem(entry.displayName(), !!rec.pin);
            item.connect("toggled", (it, state) => this.setPinned(entry, state));
            this._keepItem.menu.addMenuItem(item);
        }
        if (list.length === 0) {
            let item = new PopupMenu.PopupMenuItem(_("No icons"));
            item.setSensitive(false);
            this._keepItem.menu.addMenuItem(item);
        }
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
        if (entry.inOverflow && this.overflowMenu) {
            this.overflowMenu.close(false);   // gives the icon back to the panel before it is destroyed
            this._finishOverflowClose();
        }
        this._endTempVisit(entry, true);
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
        this._shuttingDown = true;
        this._syncAutohideTimer();
        this._saveAutohide();
        this._destroyOverflowMenu();
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
