/**
 * lib/sshHelper.ts — SSH TO A HOME PC THROUGH GGGH, FROM A MAC / LINUX BOX
 *
 * `ssh` can run a "ProxyCommand": a program whose stdin/stdout stand in for
 * the network connection. This is that program, in Python 3 (already on a Mac
 * with the developer tools; standard library only). It opens a WebSocket to
 * GGGH (with the PC's launcher token), GGGH joins it to the PC's agent, and
 * the agent hands it to the PC's own SSH server. Only encrypted SSH bytes pass
 * through; the PC still decides who gets in (keys).
 */

const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

const PY = String.raw`#!/usr/bin/env python3
# Gints Global Gaming Hubjob: ssh to a home PC through GGGH (use as an ssh ProxyCommand).
import base64, os, socket, ssl, struct, sys, threading, time
from urllib.parse import urlparse

API = "__API__"
TOKEN = "__TOKEN__"

u = urlparse(API.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/local-agent/ssh-client")
tls = u.scheme == "wss"
port = u.port or (443 if tls else 80)
try:
    raw = socket.create_connection((u.hostname, port), 15)
    s = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname) if tls else raw
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer %s\r\n\r\n" % (u.path, u.netloc, key, TOKEN)).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        c = s.recv(4096)
        if not c:
            break
        head += c
    first, _, rest = head.partition(b"\r\n\r\n")
    if b" 101 " not in first.split(b"\r\n")[0] + b" ":
        sys.stderr.write("GGGH said: " + first.split(b"\r\n")[0].decode("latin1") + "\n")
        sys.exit(1)
except (OSError, ssl.SSLError) as e:
    sys.stderr.write("Could not reach GGGH: %s\n" % e)
    sys.exit(1)

buf = bytearray(rest)
lock = threading.Lock()

def need(n):
    global buf
    while len(buf) < n:
        c = s.recv(65536)
        if not c:
            raise EOFError
        buf += c
    out = bytes(buf[:n])
    del buf[:n]
    return out

def send(op, payload):
    n = len(payload)
    hdr = bytes([0x80 | op])
    if n < 126:
        hdr += bytes([0x80 | n])
    elif n < 65536:
        hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
    mask = os.urandom(4)
    body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    with lock:
        s.sendall(hdr + mask + body)

def pump_in():
    try:
        while True:
            d = os.read(0, 16384)
            if not d:
                break
            send(2, d)
    except OSError:
        pass
    time.sleep(3)  # let the last answers come back before closing
    try:
        send(8, b"")
    except OSError:
        pass

threading.Thread(target=pump_in, daemon=True).start()
try:
    while True:
        b0, b1 = need(2)
        op, n = b0 & 15, b1 & 127
        if n == 126:
            n = struct.unpack(">H", need(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", need(8))[0]
        data = need(n)
        if op in (0, 1, 2):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        elif op == 8:
            if len(data) > 2:
                sys.stderr.write("GGGH: " + data[2:].decode("utf8", "replace") + "\n")
            break
        elif op == 9:
            send(10, data)
except (EOFError, OSError):
    pass
`;

export function buildSshProxy(api: string, token: string): string {
  return PY.replace('__API__', api.replace(/["\\\n]/g, '')).replace('__TOKEN__', token.replace(/[^\w-]/g, ''));
}

function b64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  let bin = '';
  new TextEncoder().encode(text).forEach((c) => { bin += String.fromCharCode(c); });
  return btoa(bin);
}

/** The ssh alias for a PC ("Big Gaming PC" -> big-gaming-pc). */
export const sshAlias = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home-pc';

/**
 * One line to paste into Terminal: saves the helper under ~/gggh and adds a
 * Host entry to ~/.ssh/config (once), so `ssh <alias>` just works from anywhere.
 */
export function sshSetupCommand(opts: { api: string; token: string; name: string; user: string }): string {
  const alias = sshAlias(opts.name);
  const helper = `$HOME/gggh/ssh-${alias}.py`;
  const user = (opts.user || 'YOUR_WINDOWS_USER').replace(/[^\w.$-]/g, '');
  const stanza = `\n# GGGH: ${opts.name} over the internet\nHost ${alias}\n  HostName localhost\n  User ${user}\n  ProxyCommand python3 ${helper}\n  ServerAliveInterval 30\n`;
  return [
    `mkdir -p "$HOME/gggh" "$HOME/.ssh" && echo ${sq(b64(buildSshProxy(opts.api, opts.token)))} | openssl base64 -d -A > "${helper}" && chmod 700 "${helper}"`,
    `grep -q "^Host ${alias}$" "$HOME/.ssh/config" 2>/dev/null || echo ${sq(b64(stanza))} | openssl base64 -d -A >> "$HOME/.ssh/config"`,
    `echo "Done. Connect with:  ssh ${alias}"`,
  ].join(' && ') + '\n';
}
