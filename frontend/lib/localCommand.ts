/**
 * lib/localCommand.ts — THE MOONLIGHT COMMAND FOR YOUR OWN PC
 *
 * Builds the terminal script for one local machine (Windows + Sunshine on the
 * home network). On macOS / Linux it:
 *   1. wakes the PC if it's asleep (Wake-on-LAN, then waits for Sunshine),
 *   2. asks GGGH (through the agent) to match the PC's screen to this device,
 *   3. runs `moonlight stream` for the chosen app,
 *   4. puts the PC's screen back when the stream ends.
 * Streaming itself needs only the PC's address: if GGGH can't be reached the
 * screen steps are skipped with a note, and the stream still starts.
 * On Windows only the plain `moonlight stream` line is offered.
 *
 * The script holds the machine's "launcher" token: it can only ask for the
 * screen to match / be put back, never power off or run anything.
 */

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
  matchScreen: boolean;
  /** Moonlight's own overlay: decode time, dropped frames, network delay. The first thing to look at for lag. */
  overlay?: boolean;
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
  if (l.matchScreen) lines.push(`API=${sq(l.api)}`, `TOKEN=${sq(l.token)}`);
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

  if (l.matchScreen) {
    lines.push(
      '',
      '# Ask GGGH (through the agent on the PC) to match the PC\'s screen to this device, and put it back afterwards.',
      'screen() {',
      '  curl -fsS -m "$2" -X POST -H "Authorization: Bearer $TOKEN" -H \'Content-Type: application/json\' -d "$1" "$API/local-agent/screen" 2>/dev/null \\',
      `    | sed -n 's/.*"message":"\\([^"]*\\)".*/\\1/p'`,
      '}',
      `msg=$(screen '{"action":"set","width":${l.width},"height":${l.height},"fps":${l.fps}}' 30)`,
      'echo "${msg:-Could not reach GGGH, so the screen of the PC was left as it is.}"',
      `restore() { screen '{"action":"restore"}' 10 >/dev/null; }`,
      'trap restore EXIT',
    );
  }

  lines.push('', `${exe} ${streamArgs(l).join(' ')}`);
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
