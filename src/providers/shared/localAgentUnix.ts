/**
 * src/providers/shared/localAgentUnix.ts — THE macOS / LINUX PC'S SIDE OF "LOCAL MACHINES" (bash)
 *
 * INSTALL_SH  run once as root on the machine (the app shows the command, with the agent's token
 *             on its command line; the script itself holds no secret). It installs jq and Sunshine
 *             where it can, gives Sunshine a login only this machine knows, saves the agent's token
 *             where only root can read it, turns on Wake-on-LAN where the hardware allows, and
 *             registers the agent as a service that starts at boot (launchd on macOS, systemd on
 *             Linux), restarted by the system if it stops.
 *             "--uninstall" removes the service and the agent (not Sunshine).
 *
 * AGENT_SH    the agent, the counterpart of AGENT_PS1. It connects OUT to GGGH (HTTPS long-poll), reports
 *             status and does ONE of a fixed list of things per command: refresh, sleep, restart, shutdown,
 *             sunshine-restart, sunshine-pin. Everything else the Windows agent can do (display modes,
 *             diagnose, recording, tuning, run-a-script, SSH) is answered with "not on macOS/Linux yet".
 *             It updates ITSELF the same way the Windows one does: GGGH says when the copy it serves
 *             differs (by SHA-256); the agent downloads it, checks the hash and that it parses (bash -n),
 *             keeps the old one as .bak, and exits so the system restarts it. A new copy that stops
 *             3 times in a row is replaced by the .bak.
 *
 * Needs only bash 3.2+ (the one macOS ships), curl and jq. No backticks or dollar-brace anywhere
 * (String.raw template).
 */

import crypto from 'crypto';

export const AGENT_SH = String.raw`#!/bin/bash
# GGGH agent for a local macOS or Linux machine. Connects out to GGGH; opens nothing.
AGENT_VERSION=1
DIR=/usr/local/lib/gggh
CFG="$DIR/agent.json"
AGENT_FILE="$DIR/gggh-agent.sh"
LOG="$DIR/agent.log"
case "$(uname -s)" in Darwin) PLATFORM=macos ;; *) PLATFORM=linux ;; esac
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/sbin"

log() {
  echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG" 2>/dev/null
  if [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 400000 ]; then mv -f "$LOG" "$LOG.old"; fi
}

API=$(jq -r '.api' "$CFG" 2>/dev/null)
TOKEN=$(jq -r '.token' "$CFG" 2>/dev/null)
SUN_USER=$(jq -r '.sunshineUser // "gggh"' "$CFG" 2>/dev/null)
SUN_PASS=$(jq -r '.sunshinePassword // ""' "$CFG" 2>/dev/null)
RUN_AS=$(jq -r '.runAs // ""' "$CFG" 2>/dev/null)
if [ -z "$API" ] || [ -z "$TOKEN" ] || [ "$API" = "null" ]; then echo "No agent settings at $CFG. Run the install command from GGGH again." >&2; exit 1; fi

post() { # path, timeout; JSON body on stdin; prints the answer. Non-zero when the call failed.
  curl -fsS -m "$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/local-agent/$1"
}

report() { # id ok message
  jq -nc --arg id "$1" --argjson ok "$2" --arg message "$3" '{id:$id,ok:$ok,message:$message}' | post result 20 >/dev/null 2>&1 || log "could not report a result"
}

LAST_BEAT=0
beat() {
  local now; now=$(date +%s)
  if [ $((now - LAST_BEAT)) -ge 15 ]; then LAST_BEAT=$now; echo '{}' | post heartbeat 10 >/dev/null 2>&1; fi
}

hash_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | awk '{print $1}'; else shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; fi; }

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
net_info() { # sets NET_DEV NET_IP NET_MAC NET_WIRED
  NET_DEV=""; NET_IP=""; NET_MAC=""; NET_WIRED=true
  if [ "$PLATFORM" = macos ]; then
    NET_DEV=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    [ -n "$NET_DEV" ] || return
    NET_IP=$(ipconfig getifaddr "$NET_DEV" 2>/dev/null)
    NET_MAC=$(ifconfig "$NET_DEV" 2>/dev/null | awk '/ether/{print toupper($2)}')
    if networksetup -listallhardwareports 2>/dev/null | grep -B1 "Device: $NET_DEV" | grep -qi 'wi-fi'; then NET_WIRED=false; fi
  else
    NET_DEV=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | head -1)
    [ -n "$NET_DEV" ] || return
    NET_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}' | head -1)
    NET_MAC=$(tr 'a-f' 'A-F' < "/sys/class/net/$NET_DEV/address" 2>/dev/null)
    if [ -d "/sys/class/net/$NET_DEV/wireless" ]; then NET_WIRED=false; fi
  fi
}

sunshine_state() {
  if pgrep -x sunshine >/dev/null 2>&1 || pgrep -x Sunshine >/dev/null 2>&1; then echo Running; return; fi
  if command -v sunshine >/dev/null 2>&1 || [ -d /Applications/Sunshine.app ] || [ -x /opt/homebrew/bin/sunshine ] || [ -x /usr/local/bin/sunshine ]; then echo Stopped; return; fi
  if command -v flatpak >/dev/null 2>&1 && flatpak list 2>/dev/null | grep -q 'dev.lizardbyte.app.Sunshine'; then echo Stopped; return; fi
  echo NotInstalled
}

status_json() {
  local host os up ram free cpu used total gpu streaming sun now
  host=$(hostname -s 2>/dev/null || hostname)
  net_info
  if [ "$PLATFORM" = macos ]; then
    os="macOS $(sw_vers -productVersion 2>/dev/null)"
    local boot; boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*{ sec = \([0-9]*\).*/\1/p')
    now=$(date +%s); [ -n "$boot" ] || boot=$now
    up=$(awk -v n="$now" -v b="$boot" 'BEGIN{printf "%.1f", (n-b)/3600}')
    local bytes pg freepg; bytes=$(sysctl -n hw.memsize 2>/dev/null); pg=$(sysctl -n hw.pagesize 2>/dev/null)
    freepg=$(vm_stat 2>/dev/null | awk '/Pages free|Pages inactive|Pages speculative/{gsub("[.]","",$NF); s+=$NF} END{print s+0}')
    [ -n "$bytes" ] || bytes=0; [ -n "$pg" ] || pg=4096
    ram=$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1073741824}')
    free=$(awk -v f="$freepg" -v p="$pg" 'BEGIN{printf "%.1f", f*p/1073741824}')
  else
    os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")
    up=$(awk '{printf "%.1f", $1/3600}' /proc/uptime 2>/dev/null)
    ram=$(awk '/MemTotal/{printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)
    free=$(awk '/MemAvailable/{printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)
  fi
  local ncpu; ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
  cpu=$(ps -A -o %cpu= 2>/dev/null | awk -v n="$ncpu" '{s+=$1} END{v=s/n; if(v>100)v=100; printf "%d", v}')
  used=$(df -k / 2>/dev/null | awk 'NR==2{printf "%d", $3/1048576}'); total=$(df -k / 2>/dev/null | awk 'NR==2{printf "%d", ($3+$4)/1048576}')
  sun=$(sunshine_state)
  gpu='null'; streaming=false
  if command -v nvidia-smi >/dev/null 2>&1; then
    local q; q=$(nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,encoder.stats.sessionCount,memory.used,memory.total,driver_version,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null | head -1)
    if [ -n "$q" ]; then
      gpu=$(echo "$q" | jq -Rc 'split(", ") | {name:.[0], util:(.[1]|tonumber? // 0), tempC:(.[2]|tonumber? // 0), encoders:(.[3]|tonumber? // 0), vramUsedMb:(.[4]|tonumber? // 0), vramTotalMb:(.[5]|tonumber? // 0), driver:.[6], powerW:(.[7]|tonumber?), powerLimitW:(.[8]|tonumber?)}')
      streaming=$(echo "$gpu" | jq '.encoders > 0')
    fi
  fi
  jq -nc --arg v "$AGENT_VERSION" --arg host "$host" --arg platform "$PLATFORM" --arg os "$os" --arg sha "$(hash_of "$AGENT_FILE")" \
    --arg ip "$NET_IP" --arg mac "$NET_MAC" --argjson wired "$NET_WIRED" --arg sun "$sun" \
    --arg up "$up" --arg ram "$ram" --arg free "$free" --arg cpu "$cpu" --arg used "$used" --arg total "$total" \
    --argjson gpu "$gpu" --argjson streaming "$streaming" '
    {agentVersion:$v, host:$host, platform:$platform, os:$os, canUpdate:true, agentSha:$sha, sunshine:$sun, streaming:$streaming}
    + (if $ip != "" then {lanIp:$ip} else {} end) + (if $mac != "" then {mac:$mac} else {} end) + {wired:$wired}
    + (if $up != "" then {uptimeHours:($up|tonumber)} else {} end)
    + (if $ram != "" then {ramGb:($ram|tonumber)} else {} end) + (if $free != "" then {ramFreeGb:($free|tonumber)} else {} end)
    + (if $cpu != "" then {cpuPercent:($cpu|tonumber)} else {} end)
    + (if $used != "" then {diskUsedGb:($used|tonumber), diskTotalGb:($total|tonumber)} else {} end)
    + (if $gpu != null then {gpu:$gpu} else {} end)'
}

# ---------------------------------------------------------------------------
# Sunshine
# ---------------------------------------------------------------------------
sunshine_api() { # method path [json]; prints "body|status"
  if [ -n "$3" ]; then
    curl -sk -m 10 -u "$SUN_USER:$SUN_PASS" -X "$1" -H 'Content-Type: application/json' -d "$3" -w '|%{http_code}' "https://localhost:47990$2"
  else
    curl -sk -m 10 -u "$SUN_USER:$SUN_PASS" -X "$1" -w '|%{http_code}' "https://localhost:47990$2"
  fi
}

as_user() { # run a command as the person who owns Sunshine (not root)
  if [ -n "$RUN_AS" ] && [ "$RUN_AS" != root ]; then
    if [ "$PLATFORM" = linux ]; then
      local uid; uid=$(id -u "$RUN_AS")
      sudo -u "$RUN_AS" env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
    else
      sudo -u "$RUN_AS" "$@"
    fi
  else
    "$@"
  fi
}

do_sunshine_restart() {
  [ "$(sunshine_state)" = NotInstalled ] && { echo "Sunshine is not installed on this machine."; return 1; }
  if [ "$PLATFORM" = linux ] && as_user systemctl --user restart sunshine >/dev/null 2>&1; then echo "Sunshine restarted."; return 0; fi
  if [ "$PLATFORM" = macos ] && as_user brew services restart sunshine >/dev/null 2>&1; then echo "Sunshine restarted."; return 0; fi
  pkill -x sunshine 2>/dev/null; pkill -x Sunshine 2>/dev/null
  sleep 4
  if [ "$(sunshine_state)" = Running ]; then echo "Sunshine restarted."; return 0; fi
  if [ "$PLATFORM" = macos ]; then as_user open -a Sunshine >/dev/null 2>&1; else as_user sh -c 'nohup sunshine >/dev/null 2>&1 &'; fi
  sleep 5
  if [ "$(sunshine_state)" = Running ]; then echo "Sunshine restarted."; return 0; fi
  echo "Sunshine was stopped but did not start again. Start it from the machine's desktop."; return 1
}

do_pin() { # pin name
  local pin="$1" name="$2" end last="Sunshine did not answer." r code body
  end=$(( $(date +%s) + 150 ))
  [ -n "$name" ] || name=GGGH
  while [ "$(date +%s)" -lt "$end" ]; do
    beat
    r=$(sunshine_api POST /api/pin "$(jq -nc --arg pin "$pin" --arg name "$name" '{pin:$pin,name:$name}')")
    code=$(echo "$r" | awk -F'|' '{print $NF}'); body=$(echo "$r" | sed 's/|[0-9]*$//')
    if [ "$code" = 401 ]; then echo "Sunshine rejected the login the agent saved. Run the install command again to reset it."; return 1; fi
    if [ "$code" = 200 ] && [ "$(echo "$body" | jq -r '.status' 2>/dev/null)" = true ]; then echo "Paired. Moonlight is now allowed to stream from this machine."; return 0; fi
    [ "$code" = 200 ] && last="No device is waiting to pair yet. Run the moonlight pair command now."
    sleep 2
  done
  echo "$last"; return 1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
run_command() { # one command as JSON
  local id kind msg
  id=$(echo "$1" | jq -r '.id'); kind=$(echo "$1" | jq -r '.kind')
  log "command $kind"
  case "$kind" in
    refresh) report "$id" true "Status refreshed." ;;
    sunshine-restart) if msg=$(do_sunshine_restart); then report "$id" true "$msg"; else report "$id" false "$msg"; fi ;;
    sunshine-pin) if msg=$(do_pin "$(echo "$1" | jq -r '.args.pin // ""')" "$(echo "$1" | jq -r '.args.name // ""')"); then report "$id" true "$msg"; else report "$id" false "$msg"; fi ;;
    sleep)
      report "$id" true "Going to sleep."
      if [ "$PLATFORM" = macos ]; then (sleep 2; pmset sleepnow) >/dev/null 2>&1 & else (sleep 2; systemctl suspend) >/dev/null 2>&1 & fi ;;
    restart) report "$id" true "Restarting."; (sleep 3; shutdown -r now) >/dev/null 2>&1 & ;;
    shutdown)
      report "$id" true "Shutting down."
      if [ "$PLATFORM" = macos ]; then (sleep 3; shutdown -h now) >/dev/null 2>&1 & else (sleep 3; systemctl poweroff) >/dev/null 2>&1 & fi ;;
    display-set|display-headless|display-restore|diagnose|record|logs|power-plan|gpu-clocks|sunshine-config|sunshine-config-restore|script|ssh-setup|tunnel-open|away-prepare|away-diagnose|ssh-diagnose)
      report "$id" false "This isn't available on a $PLATFORM machine yet (only the Windows agent can do it)." ;;
    *) report "$id" false "Unknown command: $kind" ;;
  esac
}

# ---------------------------------------------------------------------------
# Updating itself. GGGH says which file differs and what its SHA-256 should be.
# ---------------------------------------------------------------------------
try_update() { # sha
  local sha="$1" tmp="$AGENT_FILE.new" tried="$DIR/update.tried"
  if [ -f "$tried" ] && [ "$(cut -d'|' -f1 "$tried")" = "$sha" ] && [ $(( $(date +%s) - $(cut -d'|' -f2 "$tried") )) -lt 300 ]; then return; fi
  echo "$sha|$(date +%s)" > "$tried"
  if ! curl -fsS -m 60 -o "$tmp" "$API/local-agent/agent.sh"; then log "update: download failed"; rm -f "$tmp"; return; fi
  if [ "$(hash_of "$tmp")" != "$sha" ]; then log "update: the download did not match its fingerprint; ignored, will retry soon"; rm -f "$tmp"; return; fi
  if ! bash -n "$tmp" 2>/dev/null; then log "update: the new file does not parse; ignored"; rm -f "$tmp"; return; fi
  cp -f "$AGENT_FILE" "$AGENT_FILE.bak"; chmod 700 "$tmp"; mv -f "$tmp" "$AGENT_FILE"
  echo "$sha" > "$DIR/update.pending"
  log "updated the agent; restarting to use it"
  exit 0
}

# A fresh update that stops 3 times in a row is replaced by the previous copy.
if [ -f "$DIR/update.pending" ] && [ -f "$AGENT_FILE.bak" ]; then
  n=$(( $(cat "$DIR/update.starts" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DIR/update.starts"
  if [ "$n" -ge 3 ]; then
    cp -f "$AGENT_FILE.bak" "$AGENT_FILE"; rm -f "$DIR/update.pending" "$DIR/update.starts"
    log "the updated agent kept stopping: the previous version was put back"; exit 0
  fi
fi

log "agent $AGENT_VERSION starting ($PLATFORM)"
fails=0
while true; do
  t0=$(date +%s)
  if st=$(status_json) && r=$(echo "$st" | post poll 45); then
    fails=0
    rm -f "$DIR/update.pending" "$DIR/update.starts"
    usha=$(echo "$r" | jq -r '[.update[]? | select(.file=="agent")][0].sha256 // empty' 2>/dev/null)
    [ -n "$usha" ] && try_update "$usha"
    echo "$r" | jq -c '.commands[]?' 2>/dev/null | while IFS= read -r c; do run_command "$c"; done
    [ $(( $(date +%s) - t0 )) -lt 2 ] && sleep 2
  else
    fails=$((fails + 1))
    log "poll failed (attempt $fails)"
    if [ "$fails" -gt 3 ] && curl -s -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' "$API/local-agent/heartbeat" | grep -q 401; then sleep 60
    else sleep $(( fails * 3 > 60 ? 60 : fails * 3 )); fi
  fi
done
`;

export const INSTALL_SH = String.raw`#!/bin/bash
# GGGH local machine installer for macOS and Linux. Run as root:
#   curl -fsSL <api>/local-agent/install.sh | sudo bash -s -- --token <token> --api <api>
TOKEN=""; API=""; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) shift ;;
  esac
done
say() { echo "$*"; }
warn() { echo "! $*" >&2; }
DIR=/usr/local/lib/gggh
case "$(uname -s)" in Darwin) PLATFORM=macos ;; Linux) PLATFORM=linux ;; *) warn "This installer is for macOS and Linux. On Windows, use the PowerShell command from GGGH."; exit 1 ;; esac
if [ "$(id -u)" -ne 0 ]; then warn "Please run this as root: put sudo in front of bash (as in the command GGGH shows)."; exit 1; fi

if [ "$UNINSTALL" = 1 ]; then
  if [ "$PLATFORM" = macos ]; then launchctl bootout system/com.gggh.agent 2>/dev/null; rm -f /Library/LaunchDaemons/com.gggh.agent.plist
  else systemctl disable --now gggh-agent 2>/dev/null; rm -f /etc/systemd/system/gggh-agent.service; systemctl daemon-reload 2>/dev/null; fi
  rm -rf "$DIR"; say "GGGH agent removed. Sunshine was left in place. You can delete this PC in GGGH."; exit 0
fi

case "$TOKEN" in cgl_*) ;; *) warn "That token does not look right. Copy the whole command from GGGH."; exit 1 ;; esac
[ -n "$API" ] || { warn "Missing --api. Copy the whole command from GGGH."; exit 1; }

# The person who sits at this machine (Sunshine runs as them, not as root).
if [ "$PLATFORM" = macos ]; then OWNER=$(stat -f %Su /dev/console 2>/dev/null); else OWNER="$SUDO_USER"; fi
[ -n "$OWNER" ] || OWNER=$(logname 2>/dev/null)
[ "$OWNER" = root ] && OWNER=""
as_owner() { if [ -n "$OWNER" ]; then sudo -u "$OWNER" "$@"; else "$@"; fi; }
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

say "1/6 Checking curl and jq..."
command -v curl >/dev/null 2>&1 || { warn "curl is needed first (install it with your package manager), then run this command again."; exit 1; }
if ! command -v jq >/dev/null 2>&1; then
  if [ "$PLATFORM" = macos ]; then
    if command -v brew >/dev/null 2>&1; then as_owner brew install jq; fi
  elif command -v apt-get >/dev/null 2>&1; then apt-get install -y jq
  elif command -v dnf >/dev/null 2>&1; then dnf install -y jq
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm jq
  elif command -v zypper >/dev/null 2>&1; then zypper install -y jq
  fi
fi
command -v jq >/dev/null 2>&1 || { warn "jq could not be installed. Install it by hand (macOS: brew install jq), then run this command again."; exit 1; }

say "2/6 Downloading the GGGH agent..."
mkdir -p "$DIR" && chmod 755 "$DIR"
curl -fsS -m 60 -o "$DIR/gggh-agent.sh" "$API/local-agent/agent.sh" || { warn "Could not download the agent from $API."; exit 1; }
chmod 700 "$DIR/gggh-agent.sh"

SUNSHINE_CMD=""
sunshine_cmd() {
  if command -v sunshine >/dev/null 2>&1; then SUNSHINE_CMD="sunshine"
  elif [ -x /Applications/Sunshine.app/Contents/MacOS/sunshine ]; then SUNSHINE_CMD="/Applications/Sunshine.app/Contents/MacOS/sunshine"
  else SUNSHINE_CMD=""; fi
}
sunshine_cmd
if [ -z "$SUNSHINE_CMD" ]; then
  say "3/6 Installing Sunshine (this takes a minute)..."
  if [ "$PLATFORM" = macos ]; then
    if command -v brew >/dev/null 2>&1; then
      as_owner brew tap lizardbyte/homebrew >/dev/null 2>&1
      as_owner brew install lizardbyte/homebrew/sunshine || warn "Sunshine did not install through Homebrew."
    else warn "Homebrew was not found. Install it from brew.sh, or install Sunshine from github.com/LizardByte/Sunshine/releases, then run this command again."; fi
  elif command -v flatpak >/dev/null 2>&1 && [ -n "$OWNER" ]; then
    as_owner flatpak install -y --user flathub dev.lizardbyte.app.Sunshine || warn "Sunshine did not install through Flatpak."
  else warn "Install Sunshine for your distribution (github.com/LizardByte/Sunshine/releases), then run this command again."; fi
  sunshine_cmd
else say "3/6 Sunshine is already installed."; fi

say "4/6 Setting Sunshine login (only this machine knows it)..."
USER_NAME=gggh; PASS=""
if [ -f "$DIR/agent.json" ]; then PASS=$(jq -r '.sunshinePassword // empty' "$DIR/agent.json" 2>/dev/null); fi
if [ -z "$PASS" ]; then
  PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  if [ -n "$SUNSHINE_CMD" ]; then as_owner $SUNSHINE_CMD --creds "$USER_NAME" "$PASS" >/dev/null 2>&1 || warn "Could not set Sunshine's login now."
  elif command -v flatpak >/dev/null 2>&1 && [ -n "$OWNER" ]; then as_owner flatpak run dev.lizardbyte.app.Sunshine --creds "$USER_NAME" "$PASS" >/dev/null 2>&1 || true; fi
fi
jq -nc --arg api "$API" --arg token "$TOKEN" --arg u "$USER_NAME" --arg p "$PASS" --arg runAs "$OWNER" '{api:$api,token:$token,sunshineUser:$u,sunshinePassword:$p,runAs:$runAs}' > "$DIR/agent.json"
chmod 600 "$DIR/agent.json"

say "5/6 Turning on Wake-on-LAN where the hardware allows..."
if [ "$PLATFORM" = macos ]; then pmset -a womp 1 >/dev/null 2>&1 || warn "Could not switch on Wake for network access."
else
  DEV=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | head -1)
  if [ -n "$DEV" ] && command -v ethtool >/dev/null 2>&1; then ethtool -s "$DEV" wol g >/dev/null 2>&1 || warn "$DEV: Wake-on-LAN not switched on (check the BIOS and the adapter settings)."; fi
fi

say "6/6 Starting the agent..."
if [ "$PLATFORM" = macos ]; then
  PLIST=/Library/LaunchDaemons/com.gggh.agent.plist
  cat > "$PLIST" <<'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gggh.agent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>/usr/local/lib/gggh/gggh-agent.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
PLISTEOF
  chown root:wheel "$PLIST"; chmod 644 "$PLIST"
  launchctl bootout system/com.gggh.agent 2>/dev/null
  launchctl bootstrap system "$PLIST" || { warn "launchd would not start the agent."; exit 1; }
else
  cat > /etc/systemd/system/gggh-agent.service <<'UNITEOF'
[Unit]
Description=GGGH agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/bin/bash /usr/local/lib/gggh/gggh-agent.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl daemon-reload && systemctl enable gggh-agent >/dev/null 2>&1 && systemctl restart gggh-agent || { warn "systemd would not start the agent."; exit 1; }
fi

say ""
say "Done. Go back to GGGH: this machine should show as online within a few seconds."
say "The agent keeps itself up to date from GGGH. Remove it with: curl -fsSL $API/local-agent/install.sh | sudo bash -s -- --uninstall"
if [ -z "$SUNSHINE_CMD" ]; then say "Sunshine is not installed yet: install it, then press Refresh on this machine's card in GGGH."; fi
[ "$PLATFORM" = macos ] && say "macOS: allow Sunshine under System Settings > Privacy & Security (Screen Recording, Accessibility) the first time it runs."
say "For waking this machine from sleep, use a wired network connection."
`;

const sha256 = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
export const AGENT_SH_SHA256 = sha256(AGENT_SH);
