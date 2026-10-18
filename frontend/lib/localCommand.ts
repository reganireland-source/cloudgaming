/**
 * lib/localCommand.ts — THE MOONLIGHT COMMAND FOR YOUR OWN PC
 *
 * Builds the terminal script for one local machine (Windows + Sunshine on the
 * home network). On macOS / Linux it:
 *   1. wakes the PC if it's asleep (Wake-on-LAN, then waits for Sunshine),
 *   2. asks GGGH (through the agent) to set the PC up for the chosen mode:
 *        Mirror    ("Control") the PC's own screens stay on, at their own
 *                  resolution, and its sound keeps coming out of the PC's own
 *                  speakers; the desktop appears on this device and this
 *                  device is muted. For setup work, nothing fast.
 *        Headless  the PC's screens go off, its speakers are muted, and a
 *                  virtual display takes over at THIS device's resolution and
 *                  refresh rate; the sound plays here (gaming);
 *   3. runs `moonlight stream` for the chosen app,
 *   4. puts the PC's screens back when the stream ends (headless only).
 * Streaming itself needs only the PC's address: if GGGH can't be reached the
 * screen steps are skipped with a note, and the stream still starts.
 * On Windows only the plain `moonlight stream` line is offered.
 *
 * The script holds the machine's "launcher" token: it can only ask for the
 * screen to match / be put back, never power off or run anything.
 */

import type { ScreenTarget } from '@/lib/screens';

export type LocalMode = 'mirror' | 'headless';
export type LocalOS = 'macos' | 'linux' | 'windows';
export type LocalCodec = 'H.264' | 'HEVC' | 'AV1';

export interface LocalLaunch {
  os: LocalOS;
  name: string;
  host: string;
  mac: string | null;
  app: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  codec: LocalCodec;
  fullscreen: boolean;
  wake: boolean;
  /** mirror: PC screens stay as they are. headless: PC screens off, a virtual display at width x height. */
  mode: LocalMode;
  /** Mirror on a Mac: mute this computer while streaming (the PC's own speakers play instead). */
  muteHere?: boolean;
  /** Moonlight's own overlay: decode time, dropped frames, network delay. The first thing to look at for lag. */
  overlay?: boolean;
  /** macOS: open Moonlight on this display (the Terminal window is moved there first). */
  target?: ScreenTarget | null;
  api: string;
  token: string;
}

export const LOCAL_MOONLIGHT_EXE: Record<LocalOS, string> = {
  macos: '/Applications/Moonlight.app/Contents/MacOS/Moonlight',
  linux: 'moonlight',
  windows: '"%ProgramFiles%\\Moonlight Game Streaming\\Moonlight.exe"',
};

/** Sunshine's usual app names (editable in its admin page). */
export const LOCAL_APPS = ['Desktop', 'Steam Big Picture'];

/** About 0.15 bit per pixel per frame: plenty on a home network (1080p60 ≈ 19, 1440p60 ≈ 33, 4K60 ≈ 75 Mbps). */
export function localBitrateKbps(w: number, h: number, fps: number): number {
  const kbps = (w * h * fps * 0.15) / 1000;
  return Math.min(150000, Math.max(8000, Math.round(kbps / 500) * 500));
}

/** Single-quote for sh. */
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function streamArgs(l: LocalLaunch): string[] {
  return [
    'stream', l.host, l.os === 'windows' ? `"${l.app}"` : sq(l.app),
    '--resolution', `${l.width}x${l.height}`,
    '--fps', String(l.fps),
    '--bitrate', String(l.bitrateKbps),
    '--video-codec', l.codec,
    '--display-mode', l.fullscreen ? 'fullscreen' : 'windowed',
    '--audio-config', 'stereo',
    '--game-optimization',
    '--quit-after',
    '--no-multi-controller', // one controller on the PC: with several, one pad can show up twice
    // Control (mirror): sound plays on the PC and the mouse suits desktop work. Headless: sound plays here only.
    ...(l.mode === 'mirror' ? ['--audio-on-host', '--absolute-mouse'] : ['--no-audio-on-host']),
    ...(l.overlay ? ['--performance-overlay'] : []),
  ];
}

/** The one-line command (Windows, or when you don't want the extra steps). */
export function plainStreamCommand(l: LocalLaunch): string {
  return [LOCAL_MOONLIGHT_EXE[l.os], ...streamArgs(l)].join(' ');
}

/** `moonlight pair <ip> --pin <PIN>`, as the app shows it while pairing. */
export function pairCommand(os: LocalOS, host: string, pin: string): string {
  return `${LOCAL_MOONLIGHT_EXE[os]} pair ${host} --pin ${pin}`;
}

/** Directed-broadcast address of the PC's /24 (e.g. 192.168.1.255), or null. */
export function broadcastFor(host: string): string | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.255` : null;
}

/**
 * Moonlight has no option for which monitor to use: its window opens on the
 * display where the program that started it is (the Terminal window). So on a
 * Mac the script first moves that Terminal window onto the chosen display
 * (Terminal.app and iTerm2 can be moved by script, without any permission
 * prompt for the app itself), and moves it back when the stream ends.
 * Defines tmove / tback; calls tmove.
 */
export function terminalMoveLines(t: ScreenTarget): string[] {
  const l = Math.round(t.left) + 60, tp = Math.round(t.top) + 80;
  return [
    '',
    '# Moonlight opens on the display where this Terminal window is, so put the Terminal on the chosen display first.',
    'case "$TERM_PROGRAM" in Apple_Terminal) TAPP=Terminal; TWIN="front window";; iTerm.app) TAPP=iTerm2; TWIN="current window";; *) TAPP=;; esac',
    'tmove() {',
    '  [ -n "$TAPP" ] || { echo "Note: this Terminal can\'t be moved by script (use Terminal or iTerm2), so Moonlight opens on the display this window is on."; return; }',
    '  OLDB=$(osascript -e "tell application \\"$TAPP\\" to get bounds of $TWIN" 2>/dev/null | tr -d \' \')',
    `  osascript -e "tell application \\"$TAPP\\" to set bounds of $TWIN to {${l}, ${tp}, ${l + 640}, ${tp + 380}}" >/dev/null 2>&1 || echo "Note: could not move the Terminal window (is it full screen?), so Moonlight opens on its display."`,
    '  sleep 1',
    '}',
    'tback() { [ -n "$OLDB" ] && osascript -e "tell application \\"$TAPP\\" to set bounds of $TWIN to {$OLDB}" >/dev/null 2>&1; }',
    'tmove',
  ];
}

export function buildLaunchScript(l: LocalLaunch): string {
  if (l.os === 'windows') return plainStreamCommand(l);
  const exe = l.os === 'macos' ? sq(LOCAL_MOONLIGHT_EXE.macos) : 'moonlight';
  const wake = l.wake && !!l.mac;
  const bc = broadcastFor(l.host);
  const lines: string[] = [
    '#!/bin/bash',
    `# Gints Global Gaming Hubjob: stream "${l.app.replace(/[\r\n"]/g, ' ')}" from ${l.name.replace(/[\r\n]/g, ' ')} (${l.host})`,
    `HOST=${sq(l.host)}`,
  ];
  if (wake) lines.push(`MAC=${sq(l.mac!)}`);
  if (l.mode) lines.push(`API=${sq(l.api)}`, `TOKEN=${sq(l.token)}`);
  lines.push(`up() { nc -z -w 2 "$HOST" 47989 >/dev/null 2>&1; }`);

  if (wake) {
    lines.push(
      '',
      '# Wake-on-LAN: the "magic packet" is 6 x FF, then the PC\'s MAC address 16 times.',
      `wake() {`,
      `  local m=\${MAC//:/}`,
      `  for t in 255.255.255.255${bc ? ` ${bc}` : ''}; do`,
      `    python3 -c "import socket,sys;m=bytes.fromhex(sys.argv[1]);s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);s.sendto(b'\\xff'*6+m*16,(sys.argv[2],9))" "$m" "$t" 2>/dev/null \\`,
      `      || { p=ffffffffffff; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do p=$p$m; done; echo "$p" | xxd -r -p | nc -u -w1 "$t" 9 2>/dev/null; }`,
      `  done`,
      `}`,
      'if ! up; then',
      `  echo "Waking ${l.name.replace(/["$`\\\r\n]/g, ' ')}..."`,
      '  wake',
      '  for i in $(seq 1 45); do up && break; sleep 2; done',
      `  up || { echo "The PC didn't wake up within 90 seconds. Is Wake-on-LAN on, and is it on a network cable?"; exit 1; }`,
      '  sleep 3',
      'fi',
    );
  } else {
    lines.push(
      '',
      'if ! up; then',
      `  echo "Can't reach Sunshine on $HOST. Is the PC on?"; exit 1`,
      'fi',
    );
  }

  const screenCall = [
    '',
    '# Ask GGGH (through the agent on the PC) to set up its screens. Streaming itself needs only the PC\'s address.',
    'screen() {',
    '  curl -fsS -m "$2" -X POST -H "Authorization: Bearer $TOKEN" -H \'Content-Type: application/json\' -d "$1" "$API/local-agent/screen" 2>/dev/null \\',
    `    | sed -n 's/.*"message":"\\([^"]*\\)".*/\\1/p'`,
    '}',
  ];
  lines.push(...screenCall);
  if (l.mode === 'headless') {
    lines.push(
      `msg=$(screen '{"action":"headless","width":${l.width},"height":${l.height},"fps":${l.fps}}' 50)`,
      'echo "${msg:-Could not reach GGGH, so the PC was left as it is.}"',
      `restore() { screen '{"action":"restore"}' 20 >/dev/null; }`,
      'trap restore EXIT',
    );
  } else {
    lines.push(
      `msg=$(screen '{"action":"restore"}' 20)`,
      'echo "Mirror: ${msg:-the own screens of the PC are used as they are.}"',
    );
  }

  if (l.os === 'macos' && l.mode === 'mirror' && l.muteHere) {
    lines.push(
      '',
      '# Control mode: the PC plays its own sound, so keep this computer quiet (and put the sound back afterwards).',
      `WASMUTED=$(osascript -e 'output muted of (get volume settings)' 2>/dev/null)`,
      `osascript -e 'set volume output muted true' >/dev/null 2>&1`,
      `unmute() { [ "$WASMUTED" = false ] && osascript -e 'set volume output muted false' >/dev/null 2>&1; }`,
      'trap unmute EXIT',
    );
  }
  if (l.os === 'macos' && l.target) lines.push(...terminalMoveLines(l.target));
  lines.push('', `${exe} ${streamArgs(l).join(' ')}`);
  if (l.os === 'macos' && l.target) lines.push('tback');
  return lines.join('\n') + '\n';
}

/**
 * "Check my side": what the Mac (or Linux box) sees of the network to the PC.
 * Half of "it's laggy" is on the client's end: Wi-Fi instead of a cable, or
 * a few lost pings. Prints which kind of link the route to the PC uses and a
 * 20-second ping summary (loss, average, worst).
 */
export function buildCheckScript(host: string): string {
  return [
    "#!/bin/bash",
    "# Gints Global Gaming Hubjob: how does this computer reach the PC?",
    `HOST=${sq(host)}`,
    "echo \"Checking the connection from this computer to $HOST (about 20 seconds)...\"",
    "if [ \"$(uname)\" = Darwin ]; then",
    "  IF=$(route -n get \"$HOST\" 2>/dev/null | awk '/interface:/{print $2}')",
    "  KIND=$(networksetup -listallhardwareports 2>/dev/null | awk -v i=\"$IF\" '/Hardware Port/{p=$0} /Device:/{if ($2==i) print p}')",
    "  case \"$KIND\" in *Wi-Fi*|*AirPort*) LINK=\"Wi-Fi\";; *) LINK=\"a cable or adapter\";; esac",
    "else",
    "  IF=$(ip route get \"$HOST\" 2>/dev/null | awk '{for(i=1;i<NF;i++) if ($i==\"dev\") print $(i+1)}' | head -1)",
    "  if [ -d \"/sys/class/net/$IF/wireless\" ]; then LINK=\"Wi-Fi\"; else LINK=\"a cable or adapter\"; fi",
    "fi",
    "echo \"This computer reaches the PC over: $LINK (${IF:-unknown interface})\"",
    "[ \"$LINK\" = \"Wi-Fi\" ] && echo \"  -> Wi-Fi is the most common cause of stutter, even when the PC itself is on a cable. Try a cable (or at least the 5 GHz band, close to the router).\"",
    "OUT=$(ping -c 20 \"$HOST\" 2>&1)",
    "echo \"$OUT\" | tail -3",
    "if ! echo \"$OUT\" | grep -q \"packet loss\"; then echo; echo \"Could not run the ping test here, so nothing was checked: $(echo \"$OUT\" | head -1)\"; exit 1; fi",
    "LOSS=$(echo \"$OUT\" | sed -n 's/.* \\([0-9.]*\\)% packet loss.*/\\1/p')",
    "MAX=$(echo \"$OUT\" | awk -F'/' '/min\\/avg\\/max/{print $6+0}')",
    "echo",
    "if [ \"${LOSS:-0}\" != \"0\" ] && [ \"${LOSS:-0}\" != \"0.0\" ]; then echo \"PROBLEM: ${LOSS}% of pings were lost. Streaming cannot be smooth like this.\"",
    "elif [ -n \"$MAX\" ] && [ \"${MAX%.*}\" -gt 20 ] 2>/dev/null; then echo \"WARNING: the slowest ping was ${MAX} ms. On a good home network it stays under about 5 ms.\"",
    "else echo \"The route to the PC looks healthy.\"; fi",
    "echo \"Next: stream with the performance overlay on (the launcher command has an option for it) and note the decode time and dropped frames.\""
  ].join('\n') + '\n';
}

/** Base64 of the script's UTF-8 bytes (browser or node). */
function b64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  let bin = '';
  new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/**
 * One line to paste into Terminal that saves a script as a file and runs it.
 * A file made in Terminal isn't quarantined, so it runs where a downloaded
 * .command file is blocked by macOS. The script travels as base64 on a single
 * line, so zsh can't mangle it (quotes, `$`, pasted multi-line input).
 * Later runs: the saved path.
 */
export function saveAndRunCommand(fileName: string, script: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, '-').toLowerCase();
  const path = `"$HOME/gggh/${safe}"`;
  return `mkdir -p "$HOME/gggh" && echo '${b64(script)}' | openssl base64 -d -A > ${path} && chmod +x ${path} && echo "Saved. Next time, just run: $HOME/gggh/${safe}" && ${path}\n`;
}
