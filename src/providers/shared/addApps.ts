/**
 * src/providers/shared/addApps.ts — ADD OUR APPS TO THE DESKTOP (Python 3)
 *
 * Run while the machine builds its streaming image (see the Dockerfile in
 * shared/setupScript.ts): adds Chrome, Discord, Battle.net and "All apps"
 * to Moonlight's app list, the app menu and the dock. Shipped inside the
 * setup script, except where it must stay small (AWS's 16 KB user data;
 * Azure with a public URL): there the machine downloads it from
 * GET /api/agent/add-apps.py, checked against ADD_APPS_SHA256 (no download
 * = the image is built without these extras). Whole-line comments are
 * dropped, as the setup script's are. No backticks or "${" (String.raw).
 */

import crypto from 'crypto';

const strip = (src: string) => src.split('\n').filter((line, i) => i === 0 || !/^\s*#(?!!)/.test(line)).join('\n');

export const ADD_APPS_SOURCE = strip(String.raw`import json, os
BNET_ICON = "/usr/share/pixmaps/battlenet.png" if os.path.exists("/usr/share/pixmaps/battlenet.png") else "/usr/share/icons/hicolor/128x128/apps/net.lutris.Lutris.png"
installed = {
    "Google Chrome": os.path.exists("/usr/bin/google-chrome"),
    "Discord": os.path.exists("/opt/Discord/Discord"),
    "Battle.net": True,
    "All apps": True,
}
ALL_APPS_ICON = "org.xfce.xfdashboard" if os.path.exists("/usr/share/icons/hicolor/scalable/apps/org.xfce.xfdashboard.svg") else "system-search"

# ---- 1. Moonlight's app list (Sunshine apps.json)
path = "/cloudy/conf/sunshine/apps.json"
with open(path) as f:
    cfg = json.load(f)
start = {"do": "sh -c \"sunshine-app-startup.sh > /tmp/sunshine-session-start.log 2>&1\""}
def app(name, image, cmd, undo=None):
    prep = dict(start)
    if undo:
        prep["undo"] = undo
    return {"name": name, "image-path": image, "prep-cmd": [prep], "detached": [cmd],
            "exclude-global-prep-cmd": "false", "auto-detach": "true", "wait-all": "true", "exit-timeout": "5", "cmd": ""}
extra = [
    app("Google Chrome", "/opt/google/chrome/product_logo_256.png",
        "sh -c \"google-chrome --start-maximized > /tmp/chrome-start.log 2>&1\""),
    app("Discord", "/opt/Discord/discord.png",
        "sh -c \"discord > /tmp/discord-start.log 2>&1\""),
    app("Battle.net", BNET_ICON,
        "sh -c \"battlenet-start.sh > /tmp/battlenet-start.log 2>&1\"",
        undo="sh -c \"lutris-stop.sh > /tmp/lutris-stop.log 2>&1\""),
]
extra = [a for a in extra if installed[a["name"]]]
names = set(installed)
cfg["apps"] = [a for a in cfg["apps"] if a.get("name") not in names] + extra
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)

# ---- 2. Desktop entries (app menu) and dock launchers
entries = {
    # plugin id: (name, desktop file name, Exec, Icon, categories)
    19: ("All apps", "all-apps.desktop", "all-apps.sh", ALL_APPS_ICON, "Utility;"),
    20: ("Battle.net", "battlenet.desktop", "battlenet-start.sh", BNET_ICON, "Game;"),
    21: ("Discord", "discord.desktop", "discord", "/opt/Discord/discord.png", "Network;InstantMessaging;"),
    22: ("Google Chrome", "google-chrome.desktop", "google-chrome", "google-chrome", "Network;WebBrowser;"),
}
entries = {pid: e for pid, e in entries.items() if installed[e[0]]}
DEFAULT = "/cloudy/conf/xfce4-default"
for pid, (name, fname, exe, icon, cats) in entries.items():
    body = ("[Desktop Entry]\nName=%s\nExec=%s\nIcon=%s\nTerminal=false\nType=Application\nCategories=%s\nStartupNotify=false\n"
            % (name, exe, icon, cats))
    if fname != "google-chrome.desktop":          # Chrome's package installs its own menu entry
        with open("/usr/share/applications/" + fname, "w") as f:
            f.write(body)
    d = "%s/panel/launcher-%d" % (DEFAULT, pid)
    os.makedirs(d, exist_ok=True)
    with open(d + "/" + fname, "w") as f:
        f.write(body)

# xfdashboard: open on the grid of ALL apps (not the window overview or
# menu folders) every time, with the search box cleared.
os.makedirs(DEFAULT + "/xfconf/xfce-perchannel-xml", exist_ok=True)
with open(DEFAULT + "/xfconf/xfce-perchannel-xml/xfdashboard.xml", "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfdashboard" version="1.0">\n'
            '  <property name="switch-to-view-on-resume" type="string" value="builtin.applications"/>\n'
            '  <property name="reset-search-on-resume" type="bool" value="true"/>\n'
            '  <property name="components" type="empty">\n'
            '    <property name="applications-view" type="empty">\n'
            '      <property name="show-all-apps" type="bool" value="true"/>\n'
            '    </property>\n  </property>\n</channel>\n')

panel = DEFAULT + "/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
with open(panel) as f:
    xml = f.read()
anchor_ids = '<value type="int" value="12"/>'                    # Lutris, in the dock order
anchor_plugins = '<property name="plugin-98" type="string" value="separator"/>'
if entries and anchor_ids in xml and anchor_plugins in xml and 'name="plugin-19"' not in xml and 'name="plugin-20"' not in xml:
    ids = "".join('\n        <value type="int" value="%d"/>' % pid for pid in entries)
    xml = xml.replace(anchor_ids, anchor_ids + ids, 1)
    plugins = "".join(
        '<property name="plugin-%d" type="string" value="launcher">\n'
        '      <property name="items" type="array">\n'
        '        <value type="string" value="%s"/>\n'
        '      </property>\n'
        '    </property>\n    ' % (pid, e[1]) for pid, e in entries.items())
    xml = xml.replace(anchor_plugins, plugins + anchor_plugins, 1)
    with open(panel, "w") as f:
        f.write(xml)
    print("Dock: added " + ", ".join(e[0] for e in entries.values()))
elif 'name="plugin-19"' in xml or 'name="plugin-20"' in xml:
    print("Dock: launchers already present")
else:
    print("WARNING: dock layout not recognised - apps are still in Moonlight and the app menu")
`);

export const ADD_APPS_SHA256 = crypto.createHash('sha256').update(ADD_APPS_SOURCE).digest('hex');
