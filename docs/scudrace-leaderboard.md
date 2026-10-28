# Scud Race lap-time leaderboard

A small leaderboard for the Scud Race hobby game (Unity, Mac and Windows, a few friends). No accounts: a lap is sent with the game's random install id and a **group code** (the friends' code). Only initials and times are stored and shown.

- **API base:** `https://cloudgaming-production.up.railway.app/api/scudrace`
- **Web page:** `https://cloudgaming-alpha.vercel.app/scudrace/` (group code in a box, or in the address: `/scudrace/#group=<code>`)
- **Code:** `src/api/routes/scudrace.ts`, `src/services/ScudraceBoard.ts`, `database/migrations/029_scudrace_scores.sql`, page in `frontend/public/scudrace/`.

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

- `mode`: `rebuilt` | `remaster` | `reimagined`. `course`: `beginner_day` | `beginner_night` | `medium` | `expert`. `car`: `ferrari` | `mclaren` | `porsche` | `viper`. `transmission`: `auto` | `manual`.
- `initials`: 3 characters A-Z or 0-9 (lower case is accepted and stored upper case).
- `lap_ms`: whole milliseconds, 20000 to 600000. `total_ms` (optional): whole number, not less than `lap_ms`, up to 3600000.
- `build`: up to 32 of `A-Z a-z 0-9 . _ + -`. `replay_hash` (optional): 8 to 64 of `A-Z a-z 0-9 _ -`.

Answer `200`: `{ "rank": 2, "best_for_install": 79876, "total_entries": 7 }`
- `rank`: this install's place on the group's board for that mode and course (all cars), after this lap.
- `best_for_install`: this install's best lap on that board.
- `total_entries`: installs on that board.

```bash
curl -s -X POST https://cloudgaming-production.up.railway.app/api/scudrace/scores \
  -H 'Content-Type: application/json' \
  -d '{"install_id":"3f6c1a7e-9b0d-4c2a-8e51-0d7a2b9f4c10","group":"abc123xyz","initials":"REG","mode":"rebuilt","course":"medium","car":"ferrari","transmission":"auto","lap_ms":80123,"build":"0.3.1"}'
```

### `GET /leaderboard`
`?group=&mode=&course=` (required) and `&car=` `&transmission=` `&limit=` (optional, default 50, max 200). Returns entries sorted fastest first, **each install once** (its best lap within the filters):

```json
[ { "rank": 1, "initials": "REG", "lap_ms": 78000, "car": "ferrari", "transmission": "manual", "build": "0.3.0", "created_at": "2026-10-28T08:15:00.000Z" } ]
```

```bash
curl -s 'https://cloudgaming-production.up.railway.app/api/scudrace/leaderboard?group=abc123xyz&mode=rebuilt&course=medium&car=ferrari&limit=20'
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
- **Limits.** 120 posts an hour per install and 120 requests a minute per address (memory only, never stored), plus a safety cap of 5000 laps a day per group.
- **Privacy.** Stored: random install id, group code, initials, mode, course, car, transmission, lap, optional total, build, optional replay hash, time. No address, user agent or hardware id.
- **Trust.** Laps are not verified; a determined friend can post a fake time. The `replay_hash` field is stored for later checking. The owner can clear a group or a mode with the admin route.
