/**
 * src/providers/shared/macClipboard.ts — ONE CLIPBOARD FOR THE MAC AND THE MACHINE (bash)
 *
 * Moonlight only types the Mac's clipboard into the stream (Ctrl+Option+
 * Shift+V, and not in every app); nothing comes back. This helper keeps the
 * Mac's clipboard and the streamed desktop's in step, both ways (text,
 * about once a second), over SSH as "dev" (one shared connection), using
 * xclip on the machine through on-desktop.
 *
 * Set up ONCE on the Mac (Developer access shows the command, with a token):
 *     bash <(curl -fsSL <API>/agent/cloud-clipboard.sh) install <token> <API>
 * It installs itself as a login item (LaunchAgent) and from then on, in the
 * background: asks the app which machine is running (DEV first) and at what
 * IP (GET /api/agent/clipboard-target), finds the SSH key in ~/.ssh that the
 * machine accepts, syncs while connected, and looks again when the machine
 * stops or its IP changes. A Mac notification says when it connects or what
 * blocks it. Also: status, uninstall, or "dev@IP [-i key]" for a one-off run.
 *
 * macOS's bash 3.2. String.raw: no backticks or "${" in the script.
 */

export const MAC_CLIPBOARD_SCRIPT = String.raw`#!/bin/bash
# cloud-clipboard: one clipboard for your Mac and your cloud machine.
#   install TOKEN API   set up once; runs in the background from then on (also after restarts)
#   status              is it running, and its last messages
#   uninstall           remove it
#   dev@IP [-i KEY]     sync with one machine now, in this window (Ctrl+C stops)
D="$HOME/.cloud-clipboard"
LOG="$D/log.txt"
LABEL=com.cloudgaming.clipboard
PL="$HOME/Library/LaunchAgents/$LABEL.plist"
LAST=""; KEY=""; NAME=""; TARGET=""; miss=0

state() {
  [ "$1" = "$LAST" ] && return; LAST=$1
  echo "$(date '+%d %b %H:%M:%S') $1" >> "$LOG"
  [ "$(wc -l < "$LOG")" -gt 500 ] && { tail -100 "$LOG" > "$LOG.t"; mv "$LOG.t" "$LOG"; }
  [ -n "$2" ] && osascript -e "display notification \"$1\" with title \"Cloud clipboard\"" >/dev/null 2>&1
  [ -t 1 ] && echo "$1"
}
sshc() {
  if [ -n "$KEY" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$D/known_hosts" -o ControlMaster=auto -o ControlPath="$D/cm-%C" -o ControlPersist=60 \
      -o IdentitiesOnly=yes -o IdentityFile="$KEY" "$TARGET" "$@"
  else
    ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$D/known_hosts" -o ControlMaster=auto -o ControlPath="$D/cm-%C" -o ControlPersist=60 "$TARGET" "$@"
  fi
}
# The key the machine accepts: the remembered one, the defaults/agent, then every key pair in ~/.ssh.
findkey() {
  sshc true </dev/null 2>"$D/err" && return 0
  grep -q "IDENTIFICATION HAS CHANGED" "$D/err" && { ssh-keygen -R "$(echo "$TARGET" | cut -d@ -f2)" -f "$D/known_hosts" >/dev/null 2>&1; sshc true </dev/null 2>"$D/err" && return 0; }
  grep -q "Permission denied" "$D/err" || return 1
  for k in "$HOME"/.ssh/*; do
    [ -f "$k" ] && [ -f "$k.pub" ] || continue
    KEY=$k
    sshc true </dev/null 2>/dev/null && { echo "KEY='$k'" > "$D/key"; return 0; }
  done
  KEY=""; echo "Permission denied" > "$D/err"; return 1
}
connect() {
  if ! findkey; then
    if grep -q "Permission denied" "$D/err"; then state "$NAME won't accept this Mac's SSH key: add your .pub key in Developer access" n
    elif [ "$miss" -ge 2 ]; then state "Can't reach $NAME over SSH: allow this Mac's IP in Developer access (home IPs change)" n
    else state "Can't reach $NAME yet - trying again"; fi
    return 1
  fi
  sshc "command -v xclip >/dev/null" </dev/null || { state "$NAME needs the newest script: Update script, then restart (or wait for its dev tools)" n; return 1; }
  sshc "on-desktop true" </dev/null >/dev/null 2>&1 || { state "Waiting for the desktop on $NAME"; return 1; }
}
get() { sshc "on-desktop xclip -o -selection clipboard 2>/dev/null" </dev/null 2>/dev/null; }
put() { sshc "on-desktop xclip -i -selection clipboard >/dev/null 2>&1" 2>/dev/null; }
sync_loop() {
  # On connect the Mac's clipboard goes over only if the machine's is empty.
  mac=$(pbpaste); cloud=$(get); fails=0; [ -n "$cloud" ] || mac=""
  while sleep 1; do
    now=$(pbpaste)
    if [ -n "$now" ] && [ "$now" != "$mac" ]; then printf %s "$now" | put || fails=$((fails + 1)); mac=$now; cloud=$now
    elif now=$(get); then
      fails=0
      if [ -n "$now" ] && [ "$now" != "$cloud" ]; then printf %s "$now" | pbcopy; cloud=$now; mac=$now; fi
    elif sshc true </dev/null 2>/dev/null; then fails=0
    else fails=$((fails + 1)); fi
    [ "$fails" -ge 3 ] && return
  done
}
run() {
  mkdir -p "$D"; . "$D/config" || exit 1; [ -f "$D/key" ] && . "$D/key"
  while true; do
    J=$(curl -fsS -m 15 -H "Authorization: Bearer $TOKEN" "$API/agent/clipboard-target" 2>"$D/err")
    if [ -z "$J" ]; then
      grep -q 401 "$D/err" && { state "The app no longer knows this Mac: set clipboard sharing up again from Developer access" n; sleep 300; continue; }
      state "Can't reach the app (offline?) - trying again"; sleep 30; continue
    fi
    IP=$(printf %s "$J" | sed -n 's/.*"ip":"\([^"]*\)".*/\1/p')
    NAME=$(printf %s "$J" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
    [ -n "$IP" ] || { state "Waiting for a machine to start"; sleep 20; continue; }
    TARGET="dev@$IP"
    # A machine that just stopped can look running for a few minutes: only warn when it keeps failing.
    connect || { miss=$((miss + 1)); sleep 20; continue; }
    miss=0
    state "Clipboard shared with $NAME: copy on either side, paste on the other" n
    sync_loop
    state "Lost $NAME - looking again"
  done
}
install() {
  [ -n "$1" ] && [ -n "$2" ] || { echo "usage: install TOKEN API" >&2; exit 2; }
  command -v pbpaste >/dev/null && command -v launchctl >/dev/null || { echo "Run this on your Mac." >&2; exit 2; }
  mkdir -p "$D" "$HOME/Library/LaunchAgents"
  curl -fsSL "$2/agent/cloud-clipboard.sh" -o "$D/cloud-clipboard.sh" || { echo "Couldn't download the helper from $2" >&2; exit 1; }
  printf 'API=%s\nTOKEN=%s\n' "$2" "$1" > "$D/config"; chmod 600 "$D/config"; rm -f "$D/key"
  cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$D/cloud-clipboard.sh</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>$D/stderr.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PL" || { echo "Couldn't start it (launchctl)." >&2; exit 1; }
  echo "Done: clipboard sharing now runs in the background, also after restarts."
  echo "Whenever a machine is running it connects by itself (a notification says so). Copy on either side, paste on the other."
  echo "Check it: bash ~/.cloud-clipboard/cloud-clipboard.sh status   Remove it: ... uninstall"
}
case "$1" in
  install) install "$2" "$3" ;;
  run) run ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "Running in the background." || echo "Not running."
    tail -5 "$LOG" 2>/dev/null ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PL"; rm -rf "$D"; echo "Removed." ;;
  *@*)
    TARGET=$1; NAME=$1; miss=2; mkdir -p "$D"
    [ "$2" = "-i" ] && KEY=$3
    connect || exit 1
    echo "Sharing the clipboard with $NAME: copy on either side, paste on the other. Ctrl+C to stop."
    sync_loop; echo "Lost the connection." ;;
  *) sed -n '2,6p' "$0" 2>/dev/null || echo "usage: install TOKEN API | status | uninstall | dev@IP [-i KEY]"; exit 2 ;;
esac
`;
