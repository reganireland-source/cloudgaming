'use client';

/**
 * components/DevAccess.tsx — DEVELOPER ACCESS (SSH) TO THE MACHINES
 *
 * Every machine has a "dev" user with key-only SSH (tools such as Godot, WINE,
 * Python are optional "Extra tools" chosen when launching). Here you:
 *   - paste the SSH PUBLIC keys allowed to log in as dev (written to each
 *     machine at launch and every boot);
 *   - open SSH (TCP 22) per cloud to specific IPv4 addresses only — closed
 *     by default, never the whole internet;
 *   - copy the ssh command for each running machine;
 *   - set up the Mac clipboard helper once (POST /clipboard-token).
 * Reads GET /api/machines/ssh-access; writes PUT /ssh-keys, PUT /ssh-access/:provider.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, type ApiError } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/api';
import CloudLogo from '@/components/CloudLogo';

interface Access {
  user: string;
  keys: string[];
  clouds: Array<{ provider: string; label: string; supported: boolean; cidrs: string[]; regions: string[]; error?: string }>;
  machines: Array<{ id: string; provider: string; region: string; status: string; ip: string | null; name: string | null }>;
}

/** A machine as the Machines page knows it right now (it refreshes every 30 s, 8 s while something changes). */
export interface LiveMachine { id: string; provider: string; region: string; status: string; ip: string | null; name: string | null; instanceType?: string; dev?: boolean }

const NO_SSH = new Set(['stopped', 'stopping', 'shelved', 'shelving', 'terminated', 'deleting', 'deleted', 'failed', 'missing']);

export default function DevAccess({ machines: live }: { machines?: LiveMachine[] } = {}) {
  const [data, setData] = useState<Access | null>(null);
  const [keysText, setKeysText] = useState('');
  const [ipDraft, setIpDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clipToken, setClipToken] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<Access>('/machines/ssh-access')
      .then((d) => { setData(d); setLoadError(null); setKeysText((t) => t || d.keys.join('\n')); })
      .catch((e) => setLoadError((e as ApiError)?.message || 'Couldn’t load it.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setNote(null);
    try { await fn(); setNote(done); load(); } catch (e) { setNote(`⚠ ${(e as ApiError)?.message || 'That didn’t work.'}${(e as ApiError)?.tip ? ` ${(e as ApiError).tip}` : ''}`); } finally { setBusy(null); }
  };
  const setCidrs = (provider: string, cidrs: string[], done: string) =>
    run(provider, () => apiFetch(`/machines/ssh-access/${provider}`, { method: 'PUT', body: { cidrs } }), done);
  const setUpClipboard = () => run('clip', async () => {
    setClipToken((await apiFetch<{ token: string }>('/machines/clipboard-token', { method: 'POST' })).token);
  }, 'Copy the command below into your Mac’s Terminal.');
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(null), 1500); }, () => undefined);
  };

  if (!data) {
    return (
      <section className="neon-card rounded-lg border border-white/10 p-5">
        <h2 className="label">Developer access (SSH)</h2>
        <p className="mt-2 text-xs text-slate-400">
          {loadError
            ? <>Couldn’t load it: {loadError}. If the app was just updated, the backend probably hasn’t been redeployed yet — redeploy it, then reload this page.</>
            : 'Loading…'}
        </p>
      </section>
    );
  }
  const open = data.clouds.filter((c) => c.cidrs.length);
  // The page's live list (falls back to what this panel loaded): every machine
  // that's up or coming up with an address, DEV machines first.
  const list: LiveMachine[] = live || data.machines.map((m) => ({ ...m }));
  const running = list.filter((m) => m.ip && !NO_SSH.has(m.status))
    .sort((a, b) => Number(!!b.dev) - Number(!!a.dev) || Number(b.status === 'running') - Number(a.status === 'running'));
  const sshOpen = (provider: string) => !!data.clouds.find((c) => c.provider === provider)?.cidrs.length;
  const keysChanged = keysText.trim() !== data.keys.join('\n').trim();

  return (
    <details className="neon-card rounded-lg border border-white/10 p-5 group">
      <summary className="cursor-pointer list-none flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="label">Developer access (SSH)</h2>
        <span className="text-xs text-slate-400">
          {data.keys.length} key{data.keys.length === 1 ? '' : 's'} · {open.length ? `SSH open on ${open.map((c) => c.label).join(', ')}` : 'SSH closed'}
          <span className="ml-2 text-neon-cyan group-open:hidden">Show</span>
        </span>
      </summary>

      <div className="mt-4 space-y-5 text-xs text-slate-300">
        <p className="text-slate-400 max-w-3xl">
          Every machine has a <strong className="text-slate-200">{data.user}</strong> login (SSH key only, with passwordless sudo). Developer tools are not installed unless you tick them under
          &quot;Extra tools&quot; when launching a machine; they install in the background after the machine is ready to play (follow <code className="text-slate-200">tail -f /var/log/cg-addons.log</code>).
          {' '}To see a program on your stream (Moonlight or the browser desktop), start it with <code className="text-slate-200">on-desktop</code>, e.g. <code className="text-slate-200">on-desktop xterm</code> — without it, programs run off-screen.
        </p>

        <div className="space-y-1.5">
          <label htmlFor="dev-keys" className="text-[0.66rem] uppercase tracking-label text-slate-500">SSH public keys for {data.user} (one per line)</label>
          <textarea id="dev-keys" value={keysText} onChange={(e) => setKeysText(e.target.value)} rows={Math.min(6, Math.max(2, keysText.split('\n').length + 1))}
            placeholder="ssh-ed25519 AAAA… name   ← the whole line from your .pub file"
            className="w-full bg-cyber-darker border border-white/15 rounded px-2 py-1.5 font-mono text-[0.7rem] break-all" spellCheck={false} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={!keysChanged || busy === 'keys'}
              onClick={() => run('keys', () => apiFetch('/machines/ssh-keys', { method: 'PUT', body: { keys: keysText } }), 'Keys saved.')}>
              {busy === 'keys' ? 'Saving…' : 'Save keys'}
            </button>
            <span className="text-slate-500">Public keys only. New machines get them at launch; Google machines already running: “Update script” → restart; AWS: relaunch.</span>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[0.66rem] uppercase tracking-label text-slate-500">Who may connect (SSH port 22)</p>
          {data.clouds.map((c) => (
            <div key={c.provider} className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 w-40 shrink-0 text-slate-200"><CloudLogo provider={c.provider} size={14} />{c.label}</span>
              {!c.supported ? <span className="text-slate-500">Not available from the app yet.</span> : (
                <>
                  {c.cidrs.length ? c.cidrs.map((ip) => (
                    <span key={ip} className="inline-flex items-center gap-1 rounded border border-neon-amber/40 px-1.5 py-0.5 font-mono tabular-nums">
                      {ip}
                      <button type="button" aria-label={`Remove ${ip}`} disabled={!!busy} className="text-slate-400 hover:text-neon-pink"
                        onClick={() => setCidrs(c.provider, c.cidrs.filter((x) => x !== ip), `${ip} removed on ${c.label}.`)}>×</button>
                    </span>
                  )) : <span className="text-slate-500">closed</span>}
                  <input value={ipDraft[c.provider] || ''} onChange={(e) => setIpDraft({ ...ipDraft, [c.provider]: e.target.value })} placeholder="your IPv4, e.g. 203.0.113.7"
                    className="w-44 bg-cyber-darker border border-white/15 rounded px-1.5 py-0.5 font-mono" aria-label={`Allow an IP on ${c.label}`} />
                  <button type="button" className="text-neon-cyan hover:underline disabled:opacity-40" disabled={!!busy || !(ipDraft[c.provider] || '').trim()}
                    onClick={() => { const ip = (ipDraft[c.provider] || '').trim(); setIpDraft({ ...ipDraft, [c.provider]: '' }); setCidrs(c.provider, [...c.cidrs, ip], `SSH open on ${c.label} for ${ip}.`); }}>
                    {busy === c.provider ? 'Working…' : 'Allow'}
                  </button>
                  {c.cidrs.length > 0 && (
                    <button type="button" className="text-slate-400 hover:text-neon-pink disabled:opacity-40" disabled={!!busy}
                      onClick={() => setCidrs(c.provider, [], `SSH closed on ${c.label}.`)}>Close SSH</button>
                  )}
                  {c.error && <span className="text-neon-amber">⚠ {c.error}</span>}
                </>
              )}
            </div>
          ))}
          <p className="text-slate-500">Find the IPv4 of the computer that will connect with <code className="text-slate-300">curl -4 ifconfig.me</code> (run on that computer). Home IPs can change — update it here if SSH stops connecting.</p>
        </div>

        {running.length > 0 && (
          <div className="space-y-1">
            <p className="text-[0.66rem] uppercase tracking-label text-slate-500">Connect</p>
            {running.map((m) => {
              const cmd = `ssh ${data.user}@${m.ip}`;
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="inline-flex items-center gap-1.5 min-w-0 sm:w-72 shrink-0">
                    {m.dev && <span className="text-[0.64rem] tracking-label text-neon-purple border border-neon-purple/50 rounded px-1">DEV</span>}
                    <span className="truncate text-slate-300" title={`${m.name || m.region}${m.instanceType ? ` · ${m.instanceType}` : ''}`}>{m.name || m.region}</span>
                  </span>
                  <code className="font-mono text-slate-100">{cmd}</code>
                  <button type="button" className="text-neon-cyan hover:underline" onClick={() => copy(cmd)}>{copied === cmd ? 'Copied' : 'Copy'}</button>
                  {m.status !== 'running' && <span className="text-neon-amber">{m.status} — SSH answers once it’s up</span>}
                  {!sshOpen(m.provider) && <span className="text-neon-amber">SSH is closed on this cloud — allow your IP above</span>}
                </div>
              );
            })}
            <p className="text-slate-500">Updates by itself as machines start and stop. The IP changes each time a machine starts, and a relaunched machine has a new host key (ssh will warn once).</p>
          </div>
        )}

        {(() => {
          // Moonlight has no clipboard back to the Mac. The helper, set up once on
          // the Mac, keeps both in step over SSH with whichever machine is running.
          const cmd = clipToken ? `bash <(curl -fsSL ${API_BASE_URL}/agent/cloud-clipboard.sh) install ${clipToken} ${API_BASE_URL}` : '';
          return (
            <div className="space-y-1">
              <p className="text-[0.66rem] uppercase tracking-label text-slate-500">Copy and paste with your Mac</p>
              {cmd ? (
                <>
                  <p className="text-slate-300">Paste this once into the Mac’s Terminal app and press Return:</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-slate-100 break-all">{cmd}</code>
                    <button type="button" className="text-neon-cyan hover:underline" onClick={() => copy(cmd)}>{copied === cmd ? 'Copied' : 'Copy'}</button>
                  </div>
                  <p className="text-slate-500">This command is shown only now — it holds a private link to your account. Click Set up again any time for a new one (the old one stops working).</p>
                </>
              ) : (
                <button type="button" className="btn-neon text-xs disabled:opacity-40" disabled={busy === 'clip'} onClick={setUpClipboard}>
                  {busy === 'clip' ? 'Setting up…' : 'Set up clipboard sharing'}
                </button>
              )}
              <p className="text-slate-500">
                One-time setup. From then on it runs quietly in the background on the Mac (also after restarts): whenever a machine is running
                (DEV first) it connects by itself and a Mac notification says “Clipboard shared”. Then just copy on one side and paste on the other —
                text, within about a second. In the Linux terminal use Ctrl+Shift+C / Ctrl+Shift+V (or Cmd with Keyboard: Mac).
              </p>
              <p className="text-slate-500">
                It needs what SSH needs: your Mac’s IP allowed above and the Mac’s public key saved above, and a machine set up with the
                current script (Update script, then restart). If something blocks it, the notification says what. Check it with{' '}
                <code className="text-slate-300">bash ~/.cloud-clipboard/cloud-clipboard.sh status</code>, remove it with{' '}
                <code className="text-slate-300">… uninstall</code>.
              </p>
            </div>
          );
        })()}

        {note && <p role="status" className={note.startsWith('⚠') ? 'text-neon-amber' : 'text-neon-lime'}>{note}</p>}
      </div>
    </details>
  );
}
