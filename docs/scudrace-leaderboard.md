# Scud Race lap-time leaderboard

A small leaderboard for the Scud Race hobby game (Unity, Mac and Windows, a few friends). No accounts: a lap is sent with the game's random install id and a **group code** (the friends' code). Only initials and times are stored and shown.

- **API base:** `https://cloudgaming-production.up.railway.app/api/scudrace`
- **Web page:** `https://cloudgaming-alpha.vercel.app/scudrace/` (group code in a box, or in the address: `/scudrace/#group=<code>`)
- **Code:** `src/api/routes/scudrace.ts`, `src/services/ScudraceBoard.ts`, `database/migrations/029_scudrace_scores.sql` (+ `032_scudrace_endurance.sql`), page in `frontend/public/scudrace/`.

## Switching it on (Railway, backend service, Variables)

| Variable | What it is |
|---|---|
| `SCUDRACE_GROUPS` | **Required.** The group codes that may post and read, comma separated, e.g. `abc123xyz,otherfriends`. Codes are case-insensitive, 3 to 32 characters of `A-Z a-z 0-9 _ -`. Without it every endpoint except `/health` answers 503. |
| `SCUDRACE_ADMIN_TOKEN` | Optional. Lets the owner clear scores (`DELETE /scores`). Without it that route answers 404. |

The group code is the only access control: anyone who knows it can post and read that group's boards. It is a shared secret between friends, not a password; keep it out of git and public posts. The game ships it in its settings or config.

## Endpoints

### `POST /scores`
Body (JSON, max 2 KB):

```json
{ "install_id": "uuid", "group": "abc123xyz", "initials": "REG",
  "mode": "rebuilt", "course": "medium", "car": "ferrari", "transmission": "auto",
  "lap_ms": 80123, "total_ms": 250000, "build": "0.3.1", "replay_hash": "optional" }
```

- `mode`: `rebuilt` | `remaster` | `reimagined` | `endurance` (see "Endurance mode" below). `course`: `beginner_day` | `beginner_night` | `medium` | `expert`. `car`: `ferrari` | `mclaren` | `porsche` | `viper`. `transmission`: `auto` | `manual`.
- `initials`: 3 characters A-Z or 0-9 (lower case is accepted and stored upper case).
- `lap_ms`: whole milliseconds, 20000 to 600000. `total_ms` (optional; **required for `endurance`**): whole number, not less than `lap_ms`, up to 3600000 (up to 2700000 for `endurance`).
- `build`: up to 32 of `A-Z a-z 0-9 . _ + -`.
- `replay_hash` (optional): 16 hex characters (lower case; upper case is accepted and lowered). A full 64-hex SHA-256 is also accepted and the first 16 characters are kept. A resend of the same lap may bring a hash the first send lacked.

Answer `200`: `{ "rank": 2, "best_for_install": 79876, "total_entries": 7, "id": 412, "replay_wanted": true }`
- `rank`: this install's place on the group's board for that mode and course (all cars), after this lap.
- `best_for_install`: this install's best lap on that board.
- `total_entries`: installs on that board.
- `id`: this lap's score row id (use it to upload the replay). `null` if the lap was not among the install's best 5 and was dropped at once.
- `replay_wanted`: `true` when the row has a `replay_hash` and no stored replay yet, so the game should now `POST /replays`.

```bash
curl -s -X POST https://cloudgaming-production.up.railway.app/api/scudrace/scores \
  -H 'Content-Type: application/json' \
  -d '{"install_id":"3f6c1a7e-9b0d-4c2a-8e51-0d7a2b9f4c10","group":"abc123xyz","initials":"REG","mode":"rebuilt","course":"medium","car":"ferrari","transmission":"auto","lap_ms":80123,"build":"0.3.1"}'
```

#### Endurance mode (`mode: "endurance"`)
An Endurance Cup (16 or 24 laps) or marathon run. One row per run; the board for a group, course is ranked by **`total_ms`, lowest first** (the other modes still rank by `lap_ms`).
- `total_ms` is **required**, not less than `lap_ms`, **at most 2700000 (45 minutes)**. `lap_ms` stays the run's best single lap (same 20000 to 600000 bounds).
- Optional extras, stored and shown but not ranked: `stops` (whole number 0 to 5), `laps` (whole number 1 to 100; then `total_ms` must be at least `laps * lap_ms`), `tyre_class` (up to 16 of `A-Z a-z 0-9 _ -`). They are ignored for the other modes.
- In the answer, `best_for_install` is this install's best **total** (the ranking value) on that endurance board.
- Replays for an endurance run may be up to **65536 bytes** (see `POST /replays`); the other modes stay at 16384.
- The unique-lap check is the same (install, group, mode, course, car, transmission, `lap_ms`, `total_ms`), so a retry is stored once.

Test vector (answer on an empty board for this group):

```bash
curl -s -X POST https://cloudgaming-production.up.railway.app/api/scudrace/scores \
  -H 'Content-Type: application/json' \
  -d '{"install_id":"3f6c1a7e-9b0d-4c2a-8e51-0d7a2b9f4c10","group":"abc123xyz","initials":"REG","mode":"endurance","course":"medium","car":"ferrari","transmission":"auto","lap_ms":78000,"total_ms":1900000,"stops":2,"laps":24,"tyre_class":"medium","build":"0.4.0"}'
# 200 {"rank":1,"best_for_install":1900000,"total_entries":1,"id":<n>,"replay_wanted":false}
# Rejected (400): the same without total_ms; total_ms 2700001; stops 6; laps 24 with total_ms 1000000 (24 x 78000 = 1872000 > total).
```

### `GET /leaderboard`
`?group=&mode=&course=` (required) and `&car=` `&transmission=` `&limit=` (optional, default 50, max 200). Returns entries sorted fastest first, **each install once** (its best lap within the filters; for `mode=endurance` its best total, and each entry also has `total_ms`, `stops`, `laps`, `tyre_class`). `id` is the score row id; `replay` is `true` exactly when a replay blob is stored for that row:

```json
[ { "rank": 1, "id": 412, "replay": true, "initials": "REG", "lap_ms": 78000, "car": "ferrari", "transmission": "manual", "build": "0.3.0", "created_at": "2026-10-28T08:15:00.000Z" } ]
```

```bash
curl -s 'https://cloudgaming-production.up.railway.app/api/scudrace/leaderboard?group=abc123xyz&mode=rebuilt&course=medium&car=ferrari&limit=20'
```

### `POST /replays` (a lap's replay / ghost)
`?id=<score id>&install_id=<uuid>[&group=<code>]`. The body is the **raw bytes**, `Content-Type: application/vnd.scudrace.replay` (not JSON, not base64). Checks, in this order:

1. Body larger than 16384 bytes: `413`, unless the row is an `endurance` run's (then up to 65536 bytes). Anything above 65536 is always `413`.
2. The row `id` does not exist, does not belong to `install_id` (and `group`, if given), or has no `replay_hash`: `404 {"error":"not_found"}`. An unknown `group` is `403`.
3. The first 16 hex characters of SHA-256 of the body differ from the row's `replay_hash`: `409 {"error":"hash_mismatch"}`.
4. The blob header is wrong: bytes 0-3 must be `SRPL` (53 52 50 4C), byte 4 must be `1`, and the little-endian CRC-32 of everything before the last 4 bytes must equal the last 4 bytes: `400 {"error":"bad_blob"}`. A body not sent as raw bytes with this content type is also `400 bad_blob`.

Nothing is inflated or simulated. Success: `200 {"status":"stored","bytes":N}`; the same bytes again: `200 {"status":"exists"}`. Limit: 30 uploads an hour per install (`429` with `Retry-After`), inside the per-address limit. `group` is optional here because the `install_id` is already a secret only the game knows.

```bash
curl -s -X POST "https://cloudgaming-production.up.railway.app/api/scudrace/replays?id=412&install_id=3f6c1a7e-9b0d-4c2a-8e51-0d7a2b9f4c10&group=abc123xyz" \
  -H 'Content-Type: application/vnd.scudrace.replay' --data-binary @lap.srpl
```

### `GET /replay`
`?id=<score id>&group=<code>`. Returns the stored bytes with `Content-Type: application/vnd.scudrace.replay`, `Content-Length`, `ETag: "<replay_hash>"` and `Cache-Control: private, max-age=31536000, immutable`. `404` when there is none or the row is in another group; `403` for an unknown or missing group (**the group is required here**, so row ids can't be walked to read other groups' replays). The install id is never returned.

```bash
curl -s "https://cloudgaming-production.up.railway.app/api/scudrace/replay?id=412&group=abc123xyz" -o ghost.srpl
```

### `GET /health`
`{ "status": "ok", "enabled": true, "time": "..." }`. `enabled` is false until `SCUDRACE_GROUPS` is set.

```bash
curl -s https://cloudgaming-production.up.railway.app/api/scudrace/health
```

### `DELETE /scores` (owner only)
`?group=<code>[&mode=][&course=]` with header `X-Scudrace-Admin: <SCUDRACE_ADMIN_TOKEN>`. Deletes that group's scores (optionally one mode or course). Answer: `{ "deleted": 12 }`.

```bash
curl -s -X DELETE 'https://cloudgaming-production.up.railway.app/api/scudrace/scores?group=abc123xyz&mode=rebuilt' -H 'X-Scudrace-Admin: <token>'
```

## Status codes
`200` ok · `400` invalid input (the message says what) · `403` unknown group code · `429` slow down (see `Retry-After`) · `503` not switched on. A valid body is never answered with 400/403/404 once it is switched on. CORS is only open to the GGGH site (the Unity client does not need it).

## Decisions
- **One row per install on a board.** Boards are separate per group, mode and course. With no `car` filter an install's best lap in any car counts. Transmission is stored and can be filtered; it does not split the boards.
- **Storage.** Postgres table `scudrace_scores`; each install keeps its best 5 laps per mode, course, car and transmission (the rest are pruned). An identical resend (same install, lap and total) is stored once, so retries are safe.
- **Replay storage.** One blob per score row in `scudrace_replays` (Postgres `bytea`), removed with its row, so it goes when the row is pushed out of the install's best 5 or cleared by the admin route. At most 16 KiB each (64 KiB for an endurance run), 200 per install (oldest go first) and 25 MB per group (oldest outside the top 10 of their board go first). Request bodies are never logged. A nullable `verified` column exists on `scudrace_scores` for later checking; nothing sets it yet.
- **Limits.** 120 posts an hour per install and 120 requests a minute per address (memory only, never stored), plus a safety cap of 5000 laps a day per group.
- **Privacy.** Stored: random install id, group code, initials, mode, course, car, transmission, lap, optional total, build, optional replay hash, time. No address, user agent or hardware id.
- **Trust.** Laps are not verified; a determined friend can post a fake time. The `replay_hash` field is stored for later checking. The owner can clear a group or a mode with the admin route.
