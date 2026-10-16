/**
 * src/providers/shared/mlwebPair.ts — PAIR MOONLIGHT WEB WITH SUNSHINE (Python 3)
 *
 * Written to /usr/local/sbin/cloudgaming-mlweb-pair.py by the setup script
 * and run at every boot (a no-op once paired). Shipped inside the setup
 * script, except where the script must stay small (AWS's 16 KB user data,
 * Azure's 64 KB custom data when the app has a public URL): there the
 * machine downloads it from GET /api/agent/mlweb-pair.py and checks it
 * against MLWEB_PAIR_SHA256. Whole-line comments are dropped (as the setup
 * script's are). Must not contain backticks or "${" (String.raw template).
 */

import crypto from 'crypto';

const strip = (src: string) => src.split('\n').filter((line, i) => i === 0 || !/^\s*#(?!!)/.test(line)).join('\n');

export const MLWEB_PAIR_SOURCE = strip(String.raw`#!/usr/bin/env python3
"""Pair the browser client (moonlight-web-stream) with this machine's Sunshine.

Runs on the machine after both containers are up, on every boot; it does
nothing if already paired. Steps, all on 127.0.0.1:
  1. sign in to Moonlight Web with the machine's login (the first sign-in
     creates that user as its admin);
  2. add Sunshine (127.0.0.1:47989) as a host, unless it's there;
  3. start pairing: Moonlight Web answers with a PIN (first line of a
     streamed JSON response), which we hand to Sunshine's /api/pin with the
     same login - no one has to type it; then read the result.
Usage: MLWEB_PASSWORD=... mlweb-pair.py <moonlight-web port> <username>
"""
import http.cookiejar, json, os, ssl, sys, time, urllib.request, base64

port, user = sys.argv[1], sys.argv[2]
password = os.environ["MLWEB_PASSWORD"]
WEB = "https://127.0.0.1:%s/api" % port
SUNSHINE_PIN = "https://127.0.0.1:47990/api/pin"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE  # both use self-signed certificates on this machine
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(WEB + path, data=data, method=method, headers={"Content-Type": "application/json"})
    return opener.open(req, timeout=timeout)


def log(msg):
    print("mlweb-pair: " + msg, flush=True)


def sunshine(method, body=None):
    auth = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(SUNSHINE_PIN, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        return json.loads(r.read() or b"{}")


def send_pin(pin):
    body = {"pin": pin, "name": "Browser (Moonlight Web)"}
    # Newer Sunshine lists waiting pairing requests (GET /api/pin) and wants
    # the request's id with the PIN; older versions have no such list.
    try:
        pending = sunshine("GET").get("pairings")
    except Exception:
        pending = None
    if pending is not None:
        if not pending:
            return False  # our request hasn't reached Sunshine yet
        mine = [p for p in pending if str(p.get("address", "")).endswith("127.0.0.1")] or pending
        body["pairing_id"] = mine[-1]["id"]
    return sunshine("POST", body).get("status") in (True, "true")


# 1. Wait for Moonlight Web, then sign in.
for attempt in range(60):
    try:
        call("POST", "/login", {"name": user, "password": password}).read()
        break
    except Exception as e:  # not up yet
        if attempt == 59:
            log("Moonlight Web didn't answer: %s" % e); sys.exit(1)
        time.sleep(5)

# 2. Sunshine as a host (wait for it too: it starts after the desktop).
host_id = None
for attempt in range(60):
    try:
        # Streamed: first line = the list, later lines = live updates.
        hosts = json.loads(call("GET", "/hosts").readline()).get("hosts", [])
        if hosts:
            h = hosts[0]
            host_id = h["host_id"]
            if h.get("paired") == "Paired":
                log("already paired"); sys.exit(0)
        else:
            host_id = json.loads(call("POST", "/host", {"address": "127.0.0.1", "http_port": 47989}).readline())["host"]["host_id"]
            log("added Sunshine as host %s" % host_id)
        break
    except Exception as e:
        if attempt == 59:
            log("couldn't add Sunshine: %s" % e); sys.exit(1)
        time.sleep(5)

# 3. Pair: read the PIN, give it to Sunshine, read the outcome.
for attempt in range(5):
    try:
        resp = call("POST", "/pair", {"host_id": host_id}, timeout=120)
        first = json.loads(resp.readline())
        pin = first.get("Pin") if isinstance(first, dict) else None
        if not pin:
            raise RuntimeError("no PIN: %s" % first)
        ok = False
        for _ in range(20):  # Sunshine accepts the PIN once the pairing request has reached it
            time.sleep(1)
            try:
                if send_pin(pin):
                    ok = True; break
            except Exception:
                pass
        second = resp.readline()
        result = json.loads(second) if second.strip() else None
        if isinstance(result, dict) and "Paired" in result:
            log("paired with Sunshine"); sys.exit(0)
        log("pairing attempt %d failed (PIN accepted: %s, result: %s)" % (attempt + 1, ok, result))
    except Exception as e:
        log("pairing attempt %d error: %s" % (attempt + 1, e))
    time.sleep(10)
sys.exit(1)
`);

export const MLWEB_PAIR_SHA256 = crypto.createHash('sha256').update(MLWEB_PAIR_SOURCE).digest('hex');
