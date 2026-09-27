'use client';

/**
 * ============================================================================
 * frontend/components/CredentialManager.tsx — ADD YOUR CLOUD KEYS (ENCRYPTED)
 * ============================================================================
 *
 * The heart of the Config page. For each cloud it shows whether you've added
 * keys, and lets you add, re-check or remove them.
 *
 * WHAT HAPPENS WHEN YOU PRESS "CHECK & SAVE"
 * ------------------------------------------
 *  1. The browser does quick sanity checks (required fields, JSON parses…)
 *     so obvious mistakes are caught instantly.
 *  2. It sends the values to PUT /api/credentials/<cloud>.
 *  3. The backend runs a CHECKLIST against the real cloud: is the format
 *     right, does the cloud accept the key, are there permissions and GPU
 *     quota… Each item comes back as passed ✓ / warning ⚠ / failed ✗ with a
 *     tip. (backend: src/providers/<cloud>/checks.ts)
 *  4. Only if NOTHING failed are the keys ENCRYPTED (AES-256-GCM) and saved.
 *     Warnings are saved anyway (e.g. a GPU quota request still pending).
 *  5. The secret values are never sent back to the browser again — the page
 *     only ever shows a harmless summary (project id, key id prefix…).
 *
 * "Test only" runs the same checklist without saving anything.
 *
 * The form fields come from the backend (GET /api/credentials/forms), so
 * each cloud's form is defined next to its checks, in one place.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/auth';
import FriendlyErrorCard from './FriendlyErrorCard';

type ProviderKey = 'gcp' | 'aws' | 'azure' | 'oracle';

interface Field {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'file-text';
  required: boolean;
  placeholder?: string;
  help?: string;
  accept?: string;
  secret?: boolean;
}
interface FormSpec { label: string; intro: string; fields: Field[] }
interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  tip?: string;
  consoleUrl?: string;
  consoleLabel?: string;
}
interface CheckResult { saved: boolean; ok: boolean; checks: Check[]; summary: string; metadata: Record<string, any>; error?: string }
interface SavedSummary {
  provider: ProviderKey;
  metadata: Record<string, any>;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckSummary: string | null;
}
interface ListResponse { encryptionReady: boolean; providers: Array<{ provider: ProviderKey; label: string; saved: SavedSummary | null }> }

const ORDER: ProviderKey[] = ['gcp', 'aws', 'azure', 'oracle'];
const STATUS_ICON: Record<Check['status'], string> = { pass: '✓', warn: '⚠', fail: '✗', skip: '–' };
const STATUS_COLOUR: Record<Check['status'], string> = {
  pass: 'text-neon-lime', warn: 'text-neon-amber', fail: 'text-neon-pink', skip: 'text-slate-500',
};

/** The checklist returned by the backend, one row per check. */
export function Checklist({ result }: { result: CheckResult }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/30 p-3">
      <p className="label mb-2">Checks · {result.summary}</p>
      <ul className="space-y-2">
        {result.checks.map((c) => (
          <li key={c.id} className="flex gap-2 text-sm">
            <span className={`${STATUS_COLOUR[c.status]} w-4 flex-shrink-0 text-center`} aria-label={c.status}>{STATUS_ICON[c.status]}</span>
            <div className="min-w-0">
              <p className="text-slate-200">
                <span className="text-slate-400">{c.label}:</span> {c.message}
              </p>
              {c.tip && <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{c.tip}</p>}
              {c.consoleUrl && (
                <a href={c.consoleUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-neon-cyan hover:underline">
                  {c.consoleLabel || 'Open console'} ↗
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Quick checks in the browser before bothering the backend. Returns problems. */
function localProblems(fields: Field[], values: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const f of fields) {
    const v = (values[f.key] || '').trim();
    if (f.required && !v) problems.push(`${f.label} is required.`);
    if (v && f.accept?.includes('json')) {
      try { JSON.parse(v); } catch { problems.push(`${f.label} isn't valid JSON — paste the whole file, from { to }.`); }
    }
    if (v && f.accept?.includes('pem') && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) {
      problems.push(`${f.label} doesn't look like a private key (it should start with -----BEGIN … PRIVATE KEY-----). Make sure it isn't the PUBLIC key.`);
    }
  }
  return problems;
}

function ProviderForm({
  provider, spec, onSaved, onCancel,
}: {
  provider: ProviderKey; spec: FormSpec; onSaved: () => void; onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  // Read an uploaded file IN THE BROWSER (it isn't uploaded anywhere by this).
  const readFile = (key: string, file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) {
      setProblems([`${file.name} is too big to be a key file (over 64 KB). Pick the downloaded key.`]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set(key, String(reader.result || ''));
    reader.readAsText(file);
  };

  const submit = async (mode: 'test' | 'save') => {
    const local = localProblems(spec.fields, values);
    setProblems(local);
    setError(null);
    setResult(null);
    if (local.length) return;
    setBusy(mode);
    try {
      const res = await apiFetch<CheckResult>(
        mode === 'save' ? `/credentials/${provider}` : `/credentials/${provider}/check`,
        { method: mode === 'save' ? 'PUT' : 'POST', body: values }
      );
      setResult(res);
      if (mode === 'save' && res.saved) {
        setValues({}); // forget the secrets in the browser as soon as they're stored
        onSaved();
      }
    } catch (err) {
      const e = err as ApiError;
      // A 422 carries the checklist explaining which checks failed.
      if (e.body?.checks) setResult(e.body as CheckResult);
      else setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-300 leading-relaxed">{spec.intro}</p>
      {spec.fields.map((f) => (
        <div key={f.key}>
          <label htmlFor={`cred-${provider}-${f.key}`} className="label block mb-1.5">
            {f.label} {f.required ? <span className="text-neon-pink">*</span> : <span className="text-slate-600 normal-case tracking-normal">(optional)</span>}
          </label>
          {f.type === 'textarea' || f.type === 'file-text' ? (
            <>
              <textarea
                id={`cred-${provider}-${f.key}`}
                value={values[f.key] || ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                rows={f.type === 'file-text' ? 6 : 3}
                spellCheck={false}
                autoComplete="off"
                className={`input-neon w-full px-3 py-2 text-xs leading-relaxed ${f.secret && !reveal && values[f.key] ? '[-webkit-text-security:disc]' : ''}`}
              />
              {f.type === 'file-text' && (
                <label className="btn-neon text-xs mt-2 cursor-pointer">
                  Upload file
                  <input type="file" accept={f.accept} className="sr-only" onChange={(e) => readFile(f.key, e.target.files?.[0])} />
                </label>
              )}
            </>
          ) : (
            <input
              id={`cred-${provider}-${f.key}`}
              type={f.type === 'password' && !reveal ? 'password' : 'text'}
              value={values[f.key] || ''}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={f.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="input-neon w-full px-3 py-2"
            />
          )}
          {f.help && <p className="text-xs text-slate-500 mt-1 leading-relaxed">{f.help}</p>}
        </div>
      ))}

      {spec.fields.some((f) => f.secret) && (
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show secret values while typing
        </label>
      )}

      {problems.length > 0 && (
        <ul className="text-xs text-neon-pink space-y-1">
          {problems.map((p) => <li key={p}>✗ {p}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => submit('save')} disabled={!!busy} className="btn-neon-lime disabled:opacity-50">
          {busy === 'save' ? 'Checking & saving…' : 'Check & save'}
        </button>
        <button type="button" onClick={() => submit('test')} disabled={!!busy} className="btn-neon disabled:opacity-50">
          {busy === 'test' ? 'Testing…' : 'Test only (don\'t save)'}
        </button>
        <button type="button" onClick={onCancel} disabled={!!busy} className="text-xs text-slate-400 hover:text-slate-200 px-2">
          Cancel
        </button>
      </div>
      {busy && <p className="text-xs text-slate-400 animate-pulse">&gt; Talking to {spec.label}… this can take a few seconds.</p>}

      {result && (
        <div className="space-y-2">
          <Checklist result={result} />
          <p className={`text-sm ${result.saved ? 'text-neon-lime' : result.ok ? 'text-slate-300' : 'text-neon-pink'}`}>
            {result.saved
              ? '✓ Saved and encrypted. The secret values are no longer shown anywhere.'
              : result.ok
              ? 'All required checks passed (not saved — this was a test).'
              : result.error || 'Not saved — fix the failed checks above and try again.'}
          </p>
        </div>
      )}
      {error && <FriendlyErrorCard friendly={error.friendly} message={error.message} tip={error.tip} />}
    </div>
  );
}

export default function CredentialManager({
  initialProvider,
  onEditingChange,
}: {
  initialProvider?: ProviderKey | null;
  /** Tells the page which cloud's form is open (so the setup guide can follow). */
  onEditingChange?: (provider: ProviderKey | null) => void;
}) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [forms, setForms] = useState<Record<ProviderKey, FormSpec> | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<ProviderKey | null>(initialProvider || null);
  const [rechecking, setRechecking] = useState<ProviderKey | null>(null);
  const [recheckResult, setRecheckResult] = useState<Partial<Record<ProviderKey, CheckResult>>>({});
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ provider: ProviderKey; force: boolean; message?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, f] = await Promise.all([
        apiFetch<ListResponse>('/credentials'),
        apiFetch<Record<ProviderKey, FormSpec>>('/credentials/forms'),
      ]);
      setList(l);
      setForms(f);
      setLoadError(null);
    } catch (err) {
      setLoadError(err as ApiError);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (initialProvider) setEditing(initialProvider); }, [initialProvider]);
  useEffect(() => { onEditingChange?.(editing); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const recheck = async (provider: ProviderKey) => {
    setRechecking(provider);
    setActionError(null);
    try {
      const res = await apiFetch<CheckResult>(`/credentials/${provider}/recheck`, { method: 'POST' });
      setRecheckResult((r) => ({ ...r, [provider]: res }));
      load();
    } catch (err) {
      setActionError(err as ApiError);
    } finally {
      setRechecking(null);
    }
  };

  const remove = async (provider: ProviderKey, force: boolean) => {
    setActionError(null);
    try {
      await apiFetch(`/credentials/${provider}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      setConfirmRemove(null);
      setRecheckResult((r) => ({ ...r, [provider]: undefined }));
      load();
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'MACHINES_EXIST') {
        setConfirmRemove({ provider, force: true, message: `${e.message} ${e.tip || ''}` });
      } else {
        setActionError(e);
      }
    }
  };

  if (loadError) return <FriendlyErrorCard message={loadError.message} tip={loadError.tip} friendly={loadError.friendly} />;
  if (!list || !forms) return <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; LOADING_YOUR_CLOUD_KEYS…</p>;

  return (
    <div className="space-y-4">
      {!list.encryptionReady && (
        <FriendlyErrorCard
          message="This server can't store cloud keys yet"
          tip="Whoever runs this app needs to set CREDENTIALS_ENCRYPTION_KEY on the backend (Railway) — e.g. the output of `openssl rand -hex 32` — and redeploy. You can still use “Test only”."
        />
      )}
      {actionError && <FriendlyErrorCard friendly={actionError.friendly} message={actionError.message} tip={actionError.tip} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ORDER.map((key) => {
          const entry = list.providers.find((p) => p.provider === key);
          const saved = entry?.saved;
          const spec = forms[key];
          const buildingOut = !spec || spec.fields.length === 0;
          return (
            <div key={key} className={`neon-card rounded-lg border p-3 sm:p-5 ${editing === key ? 'border-neon-cyan/60' : 'border-white/10'} ${editing === key ? 'lg:col-span-2' : ''}`}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">{entry?.label || key}</h3>
                  {saved ? (
                    <p className={`text-xs mt-1 ${saved.lastCheckOk === false ? 'text-neon-amber' : 'text-neon-lime'}`}>
                      {saved.lastCheckOk === false ? '⚠ Saved, but the last check found problems' : '✓ Keys saved (encrypted)'}
                    </p>
                  ) : (
                    <p className="text-xs mt-1 text-slate-500">{buildingOut ? 'Setup form coming soon' : 'Not added yet'}</p>
                  )}
                </div>
                {!editing && !buildingOut && (
                  <button type="button" onClick={() => setEditing(key)} className="btn-neon text-xs">
                    {saved ? 'Replace keys' : 'Add keys'}
                  </button>
                )}
              </div>

              {/* Harmless summary of what's saved — never the secrets. */}
              {saved && editing !== key && (
                <div className="space-y-2">
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                    {Object.entries(saved.metadata).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-slate-500">{k}</dt>
                        <dd className="text-slate-300 font-mono break-all">{String(v)}</dd>
                      </div>
                    ))}
                    <dt className="text-slate-500">last check</dt>
                    <dd className="text-slate-300">
                      {saved.lastCheckedAt ? new Date(saved.lastCheckedAt).toLocaleString() : '—'}
                      {saved.lastCheckSummary ? ` · ${saved.lastCheckSummary}` : ''}
                    </dd>
                  </dl>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button type="button" onClick={() => recheck(key)} disabled={rechecking === key} className="btn-neon text-xs disabled:opacity-50">
                      {rechecking === key ? 'Re-checking…' : 'Re-check now'}
                    </button>
                    <button type="button" onClick={() => setConfirmRemove({ provider: key, force: false })} className="btn-neon-pink text-xs">
                      Remove
                    </button>
                  </div>
                  {confirmRemove?.provider === key && (
                    <div className="rounded border border-neon-pink/40 p-3 text-xs text-slate-300 space-y-2">
                      <p>{confirmRemove.message || `Remove your ${entry?.label} keys from CloudGaming Hub? (They stay valid in ${entry?.label} — delete them there too if you no longer need them.)`}</p>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => remove(key, confirmRemove.force)} className="btn-neon-pink text-xs">
                          {confirmRemove.force ? 'Remove anyway' : 'Yes, remove'}
                        </button>
                        <button type="button" onClick={() => setConfirmRemove(null)} className="text-slate-400 hover:text-slate-200 px-2">Cancel</button>
                      </div>
                    </div>
                  )}
                  {recheckResult[key] && <Checklist result={recheckResult[key]!} />}
                </div>
              )}

              {editing === key && spec && (
                <ProviderForm
                  provider={key}
                  spec={spec}
                  onSaved={() => { load(); }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        🔒 Keys are checked, then encrypted with AES-256-GCM before they're stored, and are never shown again. Only you can use them, only
        through this app. Use limited-access keys (the setup guide below shows how), and you can revoke them in your cloud console at any time.
      </p>
    </div>
  );
}
