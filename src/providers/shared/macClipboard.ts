/**
 * src/providers/shared/macClipboard.ts — TWO-WAY CLIPBOARD FOR A MAC (bash)
 *
 * Moonlight only types the Mac's clipboard into the stream (Ctrl+Option+
 * Shift+V); nothing comes back. This runs on the Mac while you work and
 * keeps the two clipboards (text) in step, both ways, about once a second:
 * copy on either side, paste on the other. It talks to the machine over SSH
 * as "dev" (one shared connection), reading/writing the streamed desktop's
 * clipboard with xclip through on-desktop (both set up by the machine).
 * Served at GET /api/agent/cloud-clipboard.sh; run it with
 *     bash <(curl -fsSL <API>/agent/cloud-clipboard.sh) dev@<machine-ip> -i ~/.ssh/<key>
 * Plain strings (not a template literal), so bash's ${…} is fine here.
 */

export const MAC_CLIPBOARD_SCRIPT = [
  '#!/bin/bash',
  '# cloud-clipboard: share the clipboard (text) between this Mac and the cloud machine, both ways. Ctrl+C stops it.',
  '[ $# -ge 1 ] || { echo "usage: cloud-clipboard dev@<machine-ip> [ssh options, e.g. -i ~/.ssh/key]" >&2; exit 2; }',
  'command -v pbpaste >/dev/null || { echo "Run this on the Mac (it uses pbcopy/pbpaste)." >&2; exit 2; }',
  'HOST=$1; shift',
  'SSH=(ssh -o ControlMaster=auto -o ControlPath=/tmp/cloud-clipboard-%C -o ControlPersist=60 -o ServerAliveInterval=15 -o ConnectTimeout=10 "$@" "$HOST")',
  'get() { "${SSH[@]}" "on-desktop xclip -o -selection clipboard 2>/dev/null" </dev/null; }',
  'put() { "${SSH[@]}" "on-desktop xclip -i -selection clipboard >/dev/null 2>&1"; }',
  '"${SSH[@]}" "command -v xclip >/dev/null && on-desktop true" </dev/null || { echo "Can\'t reach the streamed desktop over SSH (machine still starting? SSH allowed from this IP? dev tools installed?)." >&2; exit 1; }',
  'mac=$(pbpaste); cloud=$(get)',
  'echo "Sharing the clipboard with $HOST: copy on either side, paste on the other. Ctrl+C to stop."',
  'while sleep 1; do',
  '  now=$(pbpaste)',
  '  if [ "$now" != "$mac" ]; then printf %s "$now" | put; mac=$now; cloud=$now; continue; fi',
  '  now=$(get) || continue',
  '  if [ -n "$now" ] && [ "$now" != "$cloud" ]; then printf %s "$now" | pbcopy; cloud=$now; mac=$now; fi',
  'done',
  '',
].join('\n');
