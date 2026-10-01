/**
 * lib/commandContext.ts — FILL IN THE SHELL COMMANDS FOR YOU
 *
 * The quota commands on Regions and in the Config guides need your project
 * / subscription / tenancy id, a region and (Google) a contact email. All
 * but the email are already known from your saved keys (their non-secret
 * metadata); the email is an optional setting (Config → Quota requests),
 * defaulting to your sign-in email. With these the commands run as pasted.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './auth';

export interface CommandContext {
  gcp?: { projectId?: string; region?: string; serviceAccount?: string };
  aws?: { region?: string; accountId?: string };
  azure?: { subscriptionId?: string; region?: string };
  oracle?: { tenancyOcid?: string; region?: string };
  /** The quota contact email set on Config (null = not set). */
  quotaEmail: string | null;
  /** The sign-in email (used when quotaEmail isn't set). */
  accountEmail: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function useCommandContext(enabled: boolean) {
  const [ctx, setCtx] = useState<CommandContext>({ quotaEmail: null, accountEmail: null });
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const [creds, contact] = await Promise.all([
        apiFetch<{ providers: Array<{ provider: string; saved: { metadata: Record<string, unknown> } | null }> }>('/credentials'),
        apiFetch<{ email: string | null; accountEmail: string | null }>('/credentials/quota-contact').catch(() => ({ email: null, accountEmail: null })),
      ]);
      const meta = (p: string) => creds.providers.find((x) => x.provider === p)?.saved?.metadata;
      const g = meta('gcp'), a = meta('aws'), z = meta('azure'), o = meta('oracle');
      setCtx({
        gcp: g && { projectId: str(g.projectId), region: str(g.region), serviceAccount: str(g.clientEmail) },
        aws: a && { region: str(a.region), accountId: str(a.accountId) },
        azure: z && { subscriptionId: str(z.subscriptionId), region: str(z.region) },
        oracle: o && { tenancyOcid: str(o.tenancyOcid), region: str(o.region) },
        quotaEmail: contact.email,
        accountEmail: contact.accountEmail,
      });
    } catch { /* not signed in / offline: commands keep their placeholders */ }
  }, [enabled]);
  useEffect(() => { load(); }, [load]);
  return { ctx, reload: load };
}

/** The email to put in quota requests. */
export const contactEmail = (ctx: CommandContext) => ctx.quotaEmail || ctx.accountEmail || null;

/**
 * Replace the placeholders in a command with what we know. Anything still
 * unknown keeps its readable placeholder (e.g. <your-project-id>).
 */
export function fillCommand(code: string, ctx: CommandContext, provider?: string): string {
  const email = contactEmail(ctx);
  let out = code;
  if (email) out = out.replace(/YOUR_EMAIL|<your email>|<you>/g, email);
  if (ctx.gcp?.projectId) out = out.replace(/<your-project-id>/g, ctx.gcp.projectId);
  if (ctx.azure?.subscriptionId) out = out.replace(/<subscription-id>/g, ctx.azure.subscriptionId);
  if (ctx.oracle?.tenancyOcid) out = out.replace(/<tenancy-ocid>/g, ctx.oracle.tenancyOcid);
  // "R=asia-southeast1   # your region" / "LOC=malaysiawest   # your region": use the region saved with the keys.
  const region = provider === 'gcp' ? ctx.gcp?.region : provider === 'azure' ? ctx.azure?.region : provider === 'oracle' ? ctx.oracle?.region : provider === 'aws' ? ctx.aws?.region : undefined;
  if (region) out = out.replace(/(^|;\s*)(R|LOC)=\S+\s+# your region$/m, `$1$2=${region}   # from your saved keys (change if needed)`);
  return out;
}
