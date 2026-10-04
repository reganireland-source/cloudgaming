/**
 * ============================================================================
 * src/services/RegionAccessService.ts — "WHERE CAN I ACTUALLY LAUNCH?"
 * ============================================================================
 *
 * GPU quotas and region switches are the most confusing part of every
 * cloud. This asks each cloud you've connected (with your saved key) about
 * EVERY region the app can launch in, and boils the answers down to one
 * status per region:
 *
 *   ready        you can launch a GPU machine here now
 *   no-quota     the region works, but your GPU quota there is too low
 *   not-enabled  the region isn't switched on for your account (AWS opt-in
 *                regions, Oracle region subscriptions, Azure sizes held back
 *                for your subscription)
 *   not-offered  the cloud doesn't sell our GPU machines in this region at
 *                all (asked live: the region lists are best knowledge)
 *   unknown      we couldn't read it (permission to read quotas missing,
 *                or the cloud didn't answer) — launching may still work
 *
 * Each non-ready region comes with the exact fix: the steps, the console
 * page, and a copy-paste command for the cloud's browser shell.
 *
 * What's asked, per cloud:
 *   Google  project "GPUs (all regions)" + each region's T4 / L4 (and spot)
 *           GPU quotas                               [Compute API]
 *   AWS     which regions are switched on + the "G and VT" on-demand / spot
 *           vCPU quotas per region                   [EC2 + Service Quotas]
 *   Azure   the NCASv3_T4 family, "Total Regional vCPUs" and Spot vCPU
 *           quotas per region                        [Compute usage API]
 *   Oracle  subscribed regions + the A10 GPU service limit per region
 *                                                    [Identity + Limits]
 *
 * Results are cached for 10 minutes per user and cloud (?refresh=true
 * skips the cache). Nothing is changed in your account.
 * ============================================================================
 */

import { CATALOGS, isProviderName } from '../providers/registry';
import type { ProviderName } from '../providers/shared/types';
import { toFriendlyError, FriendlyError } from '../providers/errors';
import { listCredentialSummaries, providerFor } from './CredentialService';
import { GCP_SHAPES, GCP_CATALOG, gpuOfMetric, quotaRequestOf, spotMetricOf, vwsMetricOf } from '../providers/gcp/catalog';
import { AWS_SHAPES } from '../providers/aws/catalog';
import { AZURE_SHAPES, T4_QUOTA_FAMILY } from '../providers/azure/catalog';
import { ORACLE_SHAPES } from '../providers/oracle/catalog';
import { TIERS, tierOf, type TierId } from './ReconService';
import { applyOffering } from './Offerings';

export type RegionStatus = 'ready' | 'no-quota' | 'not-enabled' | 'not-offered' | 'unknown' | 'not-connected';

export interface QuotaLine {
  label: string;     // "NVIDIA T4 GPUs", "G and VT on-demand vCPUs"…
  limit: number;
  used: number;
  unit: 'GPUs' | 'vCPUs';
}

export interface RegionAccess {
  region: string;
  status: RegionStatus;
  summary: string;               // one plain line
  quotas: QuotaLine[];           // on-demand GPU quota(s)
  spot: QuotaLine | null;        // spot/preemptible quota, if the cloud has a separate one
  spotReady: boolean | null;
  /** On-demand quota has room (false = spot only). null = not known. */
  onDemandReady?: boolean | null;
  /** Ready overall, but these GPU models have no free quota (GCP quotas are per GPU: T4 vs L4). */
  missingGpus?: string[];
  /** GPU models of ours the cloud doesn't sell in this region (asked live). */
  notSold?: string[];
  fix?: { steps: string[]; consoleUrl?: string; consoleLabel?: string; cli?: string };
  /** "What can I run here": each tier × normal / spot / big screen, and why. */
  run?: RunRow[];
  /** Every quota that matters here, what it unlocks, and open increase requests. */
  quotaDetail?: QuotaDetail[];
  /** Set when open requests couldn't be read (or the cloud doesn't expose them). */
  pendingNote?: string;
}

// ---------------------------------------------------------------------------
// "What can I run" grid
// ---------------------------------------------------------------------------
export type RunMode = 'normal' | 'spot' | 'big' | 'bigSpot';
export const RUN_MODES: RunMode[] = ['normal', 'spot', 'big', 'bigSpot'];
const MODE_LABEL: Record<RunMode, string> = { normal: 'Normal', spot: 'Spot', big: 'Big screen', bigSpot: 'Big screen + spot' };
export interface RunCell {
  ok: boolean | null;   // null = can't tell
  na?: boolean;         // not a thing here (tier/big screen not offered)
  inUse?: boolean;      // the quota exists but your own machines are using it all
  why: string;
  uses?: string[];      // quota keys this depends on
}
export interface RunRow { tier: TierId; label: string; shape: string; cells: Record<RunMode, RunCell> }
export interface PendingRequest { requested: number; status: string; created?: string }
export interface QuotaDetail {
  key: string;
  label: string;
  used: number | null;  // null = the cloud doesn't report usage (AWS)
  limit: number;
  unit: 'GPUs' | 'vCPUs';
  unlocks: string[];    // "Good · Normal", …
  pending?: PendingRequest[];
  /** Not enough left for even the smallest machine that uses it. */
  short?: boolean;
  /** How to ask for more: a console page and a one-line command (works in bash and PowerShell). */
  request?: { consoleUrl?: string; consoleLabel?: string; cli?: string; note?: string };
}

const na = (why: string): RunCell => ({ ok: null, na: true, why });
const isSpotMode = (m: RunMode) => m === 'spot' || m === 'bigSpot';
const isBigMode = (m: RunMode) => m === 'big' || m === 'bigSpot';

/** One row per tier (its cheapest machine sold here), plus which quota unlocks what. */
function buildRun<S extends { id: string; gpuModel: string; vcpus: number }>(
  shapes: S[], isSold: (gpuModel: string) => boolean, bigScreen: boolean | ((gpuModel: string) => boolean),
  cell: (shape: S, mode: RunMode) => RunCell, quotas: QuotaDetail[],
): { run: RunRow[]; quotaDetail: QuotaDetail[] } {
  const run: RunRow[] = TIERS.map((t) => {
    const ofTier = shapes.filter((s) => tierOf(s as any) === t.id).sort((a, b) => a.vcpus - b.vcpus);
    const soldHere = ofTier.filter((s) => isSold(s.gpuModel));
    const s = soldHere[0];
    const cells = Object.fromEntries(RUN_MODES.map((m) => [m,
      !ofTier.length ? na('This cloud has no machine in this tier')
      : !s ? na(`No ${uniq(ofTier.map((x) => x.gpuModel)).join('/')} machines sold in this region`)
      : isBigMode(m) && !bigScreen ? na('Big screen isn’t offered on this cloud')
      : isBigMode(m) && typeof bigScreen === 'function' && !bigScreen(s.gpuModel) ? na(`Big screen isn’t offered on the ${s.gpuModel}`)
      : cell(s, m)])) as Record<RunMode, RunCell>;
    return { tier: t.id, label: t.label, shape: s ? `${s.gpuModel} · ${s.vcpus} vCPU` : ofTier[0] ? `${ofTier[0].gpuModel}` : '—', cells };
  });
  const quotaDetail = quotas.map((q) => ({
    ...q,
    unlocks: run.flatMap((r) => RUN_MODES.filter((m) => r.cells[m].uses?.includes(q.key)).map((m) => `${r.label} · ${MODE_LABEL[m]}`)),
  }));
  return { run, quotaDetail };
}

export interface CloudAccess {
  provider: ProviderName;
  label: string;
  connected: boolean;
  error?: FriendlyError;         // the whole cloud couldn't be checked
  regions: Array<RegionAccess & { name: string; lat: number; lng: number }>;
  checkedAt: string;
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: CloudAccess }>();

/** Run `fn` over items, at most `n` at a time (clouds rate-limit bursts). */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const unknown = (region: string, error: unknown, provider: string): RegionAccess => {
  const f = toFriendlyError(error, provider);
  return { region, status: 'unknown', summary: `Couldn't check: ${f.title}`, quotas: [], spot: null, spotReady: null,
    fix: { steps: f.fixes, consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel } };
};

// ---------------------------------------------------------------------------
// Live log ("terminal" on the Regions page): every cloud API call with its
// endpoint, time and a short result, and one verdict line per region.
// ---------------------------------------------------------------------------
export type LogLevel = 'info' | 'call' | 'ok' | 'warn' | 'err';
export type Log = (level: LogLevel, text: string) => void;
const noLog: Log = () => undefined;

type Describe = (args: any[], result?: any) => { api: string; host: string; out?: string };
const pairs = (usage: any[], names: RegExp) => (usage || []).filter((u) => names.test(u.name)).map((u) => `${u.name} ${u.current}/${u.limit}`).join(' · ') || 'no matching quotas';
const API: Record<ProviderName, Record<string, Describe>> = {
  aws: {
    getRegionOptIn: (_a, r) => ({ api: 'EC2 DescribeRegions AllRegions=true', host: 'ec2.us-east-1.amazonaws.com',
      out: r && `${Object.keys(r).length} regions, ${Object.values(r).filter((v) => v === 'not-opted-in').length} not switched on` }),
    getGpuTypesOffered: ([reg], r) => ({ api: 'EC2 DescribeInstanceTypeOfferings g4dn/g5/g6e', host: `ec2.${reg}.amazonaws.com`, out: r && ([...r].join(', ') || 'none sold') }),
    getQuotaRequests: ([reg], r) => ({ api: 'ServiceQuotas ListRequestedServiceQuotaChangeHistory ec2', host: `servicequotas.${reg}.amazonaws.com`, out: r === null ? 'not readable' : r && `${r.length} open request${r.length === 1 ? '' : 's'}` }),
    getEc2Quota: ([reg, code], r) => ({ api: `ServiceQuotas GetServiceQuota ec2/${code}${code === 'L-3819A6DF' ? ' (spot)' : ' (on-demand)'}`, host: `servicequotas.${reg}.amazonaws.com`, out: r == null ? undefined : `${r} vCPUs` }),
  },
  gcp: {
    getProject: (_a, r) => ({ api: 'compute.projects.get', host: 'compute.googleapis.com',
      out: r && `GPUS_ALL_REGIONS ${(r.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.usage ?? 0}/${(r.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.limit ?? 0}` }),
    getQuotaRequests: (_a, r) => ({ api: 'cloudquotas.quotaPreferences.list', host: 'cloudquotas.googleapis.com', out: r === null ? 'not readable' : r && `${r.length} open request${r.length === 1 ? '' : 's'}` }),
    getGpuZones: (_a, r) => ({ api: 'compute.acceleratorTypes.aggregatedList', host: 'compute.googleapis.com', out: r && `T4/L4 sold in ${Object.keys(r).length} regions` }),
    getRegionQuotas: ([reg], r) => ({ api: `compute.regions.get ${reg}`, host: 'compute.googleapis.com',
      out: r && ((r as any[]).filter((q) => /T4|L4/.test(q.metric)).map((q) => `${q.metric} ${q.usage}/${q.limit}`).join(' · ') || 'no T4/L4 quotas') }),
  },
  azure: {
    getSizeAvailability: ([loc], r) => ({ api: `GET Microsoft.Compute/skus $filter=location eq '${loc}'`, host: 'management.azure.com',
      out: r && (Object.entries(r).map(([k, v]: any) => `${k}${v.restricted ? ` (${v.restricted})` : ''}`).join(', ') || 'no T4 sizes') }),
    getQuotaRequests: ([loc], r) => ({ api: `GET Microsoft.Quota/quotaRequests (${loc})`, host: 'management.azure.com', out: r === null ? 'not readable' : r && `${r.length} open request${r.length === 1 ? '' : 's'}` }),
    getComputeUsage: ([loc], r) => ({ api: `GET Microsoft.Compute/locations/${loc}/usages`, host: 'management.azure.com', out: r && pairs(r, /ncasv3_?t4|^cores$|lowprioritycores/i) }),
  },
  oracle: {
    getSubscribedRegions: (_a, r) => ({ api: 'Identity ListRegionSubscriptions', host: 'identity.oci.oraclecloud.com', out: r && `${r.length} subscribed: ${r.join(', ')}` }),
    getGpuLimit: ([reg], r) => ({ api: 'Limits ListLimitValues service=compute (A10)', host: `limits.${reg}.oci.oraclecloud.com`, out: r === undefined ? undefined : r ? `A10 ${r.used}/${r.limit}` : 'no A10 limit here' }),
  },
};
const SHORT: Record<ProviderName, string> = { aws: 'AWS', gcp: 'GCP', azure: 'Azure', oracle: 'OCI' };

/** Wrap a cloud client so each described call is logged when it finishes. */
export function traced(provider: any, cloud: ProviderName, log: Log): any {
  if (log === noLog) return provider;
  return new Proxy(provider, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      const d = API[cloud][String(prop)];
      if (typeof v !== 'function') return v;
      if (!d) return v.bind(target);
      return async (...args: any[]) => {
        const t0 = Date.now();
        const { api, host } = d(args);
        log('call', `${SHORT[cloud].padEnd(5)} → ${api}  [${host}]`);
        try {
          const r = await v.apply(target, args);
          log('ok', `${SHORT[cloud].padEnd(5)} ← ${api}  ${Date.now() - t0} ms  ${d(args, r).out ?? 'ok'}`);
          return r;
        } catch (e: any) {
          log('err', `${SHORT[cloud].padEnd(5)} ✗ ${api}  ${Date.now() - t0} ms  ${String(e?.code || e?.name || 'error')}: ${String(e?.message || e).slice(0, 160)}`);
          throw e;
        }
      };
    },
  });
}

const VERDICT_LEVEL: Record<RegionStatus, LogLevel> = { ready: 'ok', 'no-quota': 'warn', 'not-enabled': 'warn', 'not-offered': 'info', unknown: 'err', 'not-connected': 'info' };
/** Log each region's outcome as soon as it's known. */
const verdict = (cloud: ProviderName, log: Log, fn: (region: string) => Promise<RegionAccess>) => async (region: string) => {
  const a = await fn(region);
  log(VERDICT_LEVEL[a.status], `${SHORT[cloud].padEnd(5)} = ${region.padEnd(24)} ${a.status.toUpperCase().replace('-', ' ')} — ${a.summary}`);
  return a;
};

/** The cloud doesn't sell our GPU machines here at all. */
const notOffered = (region: string, summary: string, consoleUrl: string, consoleLabel: string): RegionAccess => ({
  region, status: 'not-offered', summary, quotas: [], spot: null, spotReady: null,
  fix: { steps: ['Nothing to request: the cloud has no GPU machines of the kinds we launch in this region.', 'Pick the nearest region that shows Ready or No quota.'], consoleUrl, consoleLabel },
});
const uniq = <T,>(list: T[]) => Array.from(new Set(list));

// ---------------------------------------------------------------------------
// Google Cloud
// ---------------------------------------------------------------------------
async function gcpAccess(provider: any, regionIds: string[], log: Log = noLog): Promise<RegionAccess[]> {
  const project = await provider.getProject();
  const pid = provider.projectId;
  const globalLimit = Number((project.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.limit) || 0;
  const globalUsage = Number((project.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.usage) || 0;
  const quotasUrl = `https://console.cloud.google.com/iam-admin/quotas?project=${pid}`;
  const metrics = Array.from(new Set(GCP_SHAPES.map((s) => s.gpuQuotaMetric)));   // NVIDIA_T4_GPUS, NVIDIA_L4_GPUS, GPU_FAMILY:NVIDIA_RTX_PRO_6000
  const shapeOfMetric = (m: string) => GCP_SHAPES.find((sh) => sh.gpuQuotaMetric === m)!;
  const noBig = GCP_CATALOG.bigScreen.notOnGpus || [];

  // Open quota requests for the whole project (one call; null = can't read).
  const gcpPending = await provider.getQuotaRequests?.().catch(() => null) ?? null;

  // Where Google actually sells T4 / L4 (one call; null if it can't be read).
  const gpuZones: Record<string, Record<string, string[]>> | null = await provider.getGpuZones().catch(() => null);
  const allModels = uniq(GCP_SHAPES.map((sh) => sh.gpuModel));

  return mapLimit(regionIds, 5, verdict('gcp', log, async (region): Promise<RegionAccess> => {
    const sold = gpuZones ? allModels.filter((m) => gpuZones[region]?.[m]?.length) : allModels;
    if (gpuZones) void applyOffering('gcp', region, sold, allModels); // live answer corrects the catalog (Recon, launch)
    const notSold = allModels.filter((m) => !sold.includes(m));
    if (!sold.length) return notOffered(region, `Google sells no ${allModels.join(', ')} GPUs in this region`, 'https://cloud.google.com/compute/docs/gpus/gpu-regions-zones', 'Google’s GPU locations');
    const soldMetrics = metrics.filter((m) => sold.includes(shapeOfMetric(m).gpuModel));
    const soldList = sold.join(' / ');
    const withSold = (a: RegionAccess): RegionAccess => (notSold.length ? { ...a, notSold, summary: `${a.summary} · only ${sold.join('/')} sold here` } : a);
    try {
      return withSold(await (async (): Promise<RegionAccess> => {
      const q = await provider.getRegionQuotas(region);
      const line = (metric: string): QuotaLine => {
        const m = q.find((x: any) => x.metric === metric);
        return { label: `${metric.startsWith('PREEMPTIBLE_') ? 'Spot ' : ''}NVIDIA ${gpuOfMetric(metric)}${metric.includes('_VWS_') ? ' vWS' : ''} GPUs`, limit: m?.limit || 0, used: m?.usage || 0, unit: 'GPUs' };
      };
      const reported = (metric: string) => q.some((x: any) => x.metric === metric);
      const quotas = [{ label: 'GPUs (all regions)', limit: globalLimit, used: globalUsage, unit: 'GPUs' as const }, ...metrics.map(line)];
      // What can I run: each machine needs 1 GPU of its model's quota
      // (spot: the PREEMPTIBLE_ one; big screen: the _VWS_ one), and the
      // project-wide "GPUs (all regions)" must have room too.
      const globalFree = globalLimit - globalUsage;
      type Sh = { gpuModel: string; gpuQuotaMetric: string; spotQuotaMetric?: string; vwsQuotaMetric?: string };
      const metricFor = (s: Sh, m: RunMode): string | null =>
        isBigMode(m) ? (noBig.includes(s.gpuModel) ? null : (isSpotMode(m) ? 'PREEMPTIBLE_' : '') + vwsMetricOf(s))
        : isSpotMode(m) ? spotMetricOf(s) : s.gpuQuotaMetric;
      const gcpLabel = (metric: string) => {
        if (metric === 'GPUS_ALL_REGIONS') return 'GPUs (all regions)';
        return `${metric.startsWith('PREEMPTIBLE_') ? 'Spot ' : ''}${gpuOfMetric(metric)}${metric.includes('_VWS_') ? ' vWS (big screen)' : ''} GPUs`;
      };
      // The request (quota preference) for a quota here, in any state; one per quota and region.
      const prefFor = (metric: string): any => (gcpPending || [])
        .filter((x: any) => x.metric === metric && (metric === 'GPUS_ALL_REGIONS' ? !x.region : x.region === region))
        .sort((a: any, b: any) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')))[0] || null;
      // Pending = asks for more than the quota is now (granted requests drop out).
      const pendingFor = (metric: string, limit: number) => {
        const p = prefFor(metric);
        return p && (p.reconciling || p.requested > limit) ? [{ requested: p.requested, status: p.status, created: p.updated || p.created }] : [];
      };
      // One complete command: create a request, or change the one that already exists
      // ("create" fails with "Quota Preference ... already exist" if there is one).
      const requestCli = (metric: string, want: number) => {
        const { quotaId, dims } = quotaRequestOf(metric, region);
        const p = prefFor(metric);
        const common = `--project=${pid} --billing-project=${pid} --service=compute.googleapis.com --quota-id=${quotaId} --preferred-value=${want}${dims} --email=YOUR_EMAIL --justification="Personal cloud gaming VM"`;
        return p?.id ? `gcloud beta quotas preferences update ${p.id} ${common}` : `gcloud beta quotas preferences create ${common}`;
      };
      const gcpCell = (s: Sh, m: RunMode): RunCell => {
        const k = metricFor(s, m);
        if (!k) return na(`Big screen isn’t offered on the ${s.gpuModel}`);
        const l = line(k);
        const free = l.limit - l.used;
        const uses = [k, 'GPUS_ALL_REGIONS'];
        // G4's quotas (per-family, new vWS) may not be readable: say so instead of "none".
        if ((k.startsWith('GPU_FAMILY:') || k.includes('RTX_PRO_6000')) && !reported(k)) return { ok: null, why: `Couldn’t read the ${gcpLabel(k)} quota (needs the Cloud Quotas API) — request it, then try a launch`, uses };
        if (free < 1 && l.limit === 0) return { ok: false, why: `No ${gcpLabel(k)} quota here`, uses };
        if (globalFree < 1) return globalLimit > 0
          ? { ok: false, inUse: true, why: `“GPUs (all regions)”: all ${globalLimit} in use by your running machine${globalUsage === 1 ? '' : 's'}`, uses }
          : { ok: false, why: '“GPUs (all regions)” is 0 for the project', uses };
        if (free >= 1) return { ok: true, why: `${gcpLabel(k)}: ${free} free`, uses };
        return { ok: false, inUse: true, why: `${gcpLabel(k)}: all ${l.limit} in use by your running machine${l.used === 1 ? '' : 's'}`, uses };
      };
      const usedKeys = uniq(['GPUS_ALL_REGIONS', ...GCP_SHAPES.flatMap((s) => RUN_MODES.map((m) => metricFor(s, m)).filter((k): k is string => !!k))]);
      const detail = buildRun(GCP_SHAPES, (g) => (sold as string[]).includes(g), (g) => !noBig.includes(g), gcpCell,
        usedKeys.map((k) => {
          const l = k === 'GPUS_ALL_REGIONS' ? { limit: globalLimit, used: globalUsage } : line(k);
          const pend = pendingFor(k, l.limit);
          const short = l.limit - l.used < 1;
          const { consoleMetric } = quotaRequestOf(k, region);
          const want = Math.max(1, l.used + 1);
          const request = short ? {
            consoleUrl: `https://console.cloud.google.com/iam-admin/quotas?project=${pid}&metric=compute.googleapis.com%2F${consoleMetric}`,
            consoleLabel: `Request in the console`,
            cli: requestCli(k, want),
            note: prefFor(k)?.id
              ? `Asks for ${want} by updating your earlier request (${prefFor(k).requested}, ${prefFor(k).status}). Run in Cloud Shell (check the email is yours).`
              : `Asks for ${want}. Run in Cloud Shell (check the email is yours).`,
          } : undefined;
          return { key: k, label: gcpLabel(k), used: l.used, limit: l.limit, unit: 'GPUs' as const, unlocks: [], short, ...(request ? { request } : {}), ...(pend.length ? { pending: pend } : {}) };
        }));
      const extra = { ...detail, ...(gcpPending ? {} : { pendingNote: 'Couldn’t read open quota requests (needs the Cloud Quotas API and “Cloud Quotas Viewer” on the service account).' }) };
      const regional = soldMetrics.map(line).filter((l) => l.limit - l.used >= 1);
      const spotLines = soldMetrics.map((m) => line(spotMetricOf(shapeOfMetric(m))));
      const spotOk = spotLines.some((l) => l.limit - l.used >= 1);
      const bestSpot = spotLines.sort((a, b) => b.limit - a.limit)[0] || null;
      // Ready-to-paste requests (one complete command per line): the
      // project-wide cap and the cheapest GPU (T4) in this region.
      const cli = [
        ...(globalLimit < 1 ? [requestCli('GPUS_ALL_REGIONS', 1)] : []),
        requestCli(soldMetrics.includes('NVIDIA_T4_GPUS') ? 'NVIDIA_T4_GPUS' : soldMetrics[0] || 'NVIDIA_T4_GPUS', 1),
      ].join('\n');
      if (globalLimit - globalUsage < 1) {
        const globalFull = globalLimit > 0;
        return { region, status: 'no-quota', summary: globalFull
            ? `All ${globalLimit} GPU${globalLimit === 1 ? '' : 's'} of the project’s “GPUs (all regions)” quota ${globalLimit === 1 ? 'is' : 'are'} in use by your running machine${globalUsage === 1 ? '' : 's'} — stop one to launch another here, or request more`
            : 'Project allows 0 GPUs in total ("GPUs (all regions)")', quotas, ...extra, spot: bestSpot, spotReady: false,
          fix: { steps: globalFull
              ? [`Your running machine${globalUsage === 1 ? ' is' : 's are'} using the project’s ${globalLimit === 1 ? 'only GPU' : `${globalLimit} GPUs`}. Stop (or shelve) one to launch another — here or in any region.`,
                 `To run ${globalLimit + 1} at once, request "GPUs (all regions)" = ${globalLimit + 1} (project-wide, usually approved within minutes to a day).`]
              : ['Request "GPUs (all regions)" = 1 (once for the whole project).', `Also request "NVIDIA T4 GPUs" or "NVIDIA L4 GPUs" = 1 in ${region}.`, 'Free-trial accounts must "Activate full account" first.'],
            consoleUrl: `${quotasUrl}&metric=compute.googleapis.com%2Fgpus_all_regions`, consoleLabel: 'Request GPU quota', cli } };
      }
      if (!regional.length && spotOk) {
        // Spot VMs use the separate "Preemptible" GPU quotas.
        return { region, status: 'ready', onDemandReady: false, summary: `Spot only: ${spotLines.filter((l) => l.limit - l.used >= 1).map((l) => `${l.label.replace('Spot NVIDIA ', '')}: ${l.limit - l.used} free`).join(' · ')} · no on-demand GPU quota`, quotas, ...extra, spot: bestSpot, spotReady: true,
          fix: { steps: ['Spot machines can launch here. For on-demand ones:', `On the Quotas page, filter "NVIDIA T4 GPUs" or "NVIDIA L4 GPUs", pick ${region}, request 1.`], consoleUrl: quotasUrl, consoleLabel: 'Open Quotas', cli } };
      }
      if (!regional.length) {
        return { region, status: 'no-quota', onDemandReady: false, summary: `No T4 or L4 GPU quota in ${region}`, quotas, ...extra, spot: bestSpot, spotReady: spotOk,
          fix: { steps: [`On the Quotas page, filter "NVIDIA T4 GPUs" (cheapest) or "NVIDIA L4 GPUs", pick ${region}, request 1.`, 'For spot machines also request the "Preemptible" version.', 'Approval: minutes to 2 business days.'],
            consoleUrl: quotasUrl, consoleLabel: 'Open Quotas', cli } };
      }
      const missingGpus = soldMetrics.filter((m) => { const l = line(m); return l.limit - l.used < 1; })
        .map((m) => shapeOfMetric(m).gpuModel);
      return { region, status: 'ready', onDemandReady: true, summary: regional.map((l) => `${l.label.replace('NVIDIA ', '')}: ${l.limit - l.used} free`).join(' · '), quotas, ...extra, spot: bestSpot, spotReady: spotOk, missingGpus,
        ...(missingGpus.length ? { fix: (() => {
          const ms = missingGpus.map((g) => GCP_SHAPES.find((sh) => sh.gpuModel === g)!.gpuQuotaMetric);
          const asked = ms.filter((m) => pendingFor(m, line(m).limit).length);
          const toAsk = ms.filter((m) => !asked.includes(m));
          return { steps: [
            `Only ${regional.map((l) => l.label.replace('NVIDIA ', '')).join(' and ')} can launch here.`,
            ...asked.map((m) => `${line(m).label}: ⏳ ${pendingFor(m, line(m).limit)[0].requested} requested (${pendingFor(m, line(m).limit)[0].status}) — nothing to do but wait.`),
            ...toAsk.map((m) => `For ${gpuOfMetric(m)} machines, request "${line(m).label}" = 1 in ${region}${m.startsWith('GPU_FAMILY:') ? ' (listed as "GPUs per GPU family", gpu_family NVIDIA_RTX_PRO_6000)' : ''}.`),
          ], consoleUrl: quotasUrl, consoleLabel: 'Request GPU quota', ...(toAsk.length ? { cli: toAsk.map((m) => requestCli(m, 1)).join('\n') } : {}) };
        })() } : {}) };
      })());
    } catch (error) {
      return unknown(region, error, 'gcp');
    }
  }));
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------
const AWS_ON_DEMAND = 'L-DB2E81BA'; // Running On-Demand G and VT instances (vCPUs)
const AWS_SPOT = 'L-3819A6DF';      // All G and VT Spot Instance Requests (vCPUs)
const AWS_MIN = 4;

async function awsAccess(provider: any, regionIds: string[], log: Log = noLog): Promise<RegionAccess[]> {
  let optIn: Record<string, string> = {};
  try { optIn = await provider.getRegionOptIn(); } catch { /* treat as unknown below */ }
  return mapLimit(regionIds, 4, verdict('aws', log, async (region): Promise<RegionAccess> => {
    const quotasUrl = `https://${region}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas/${AWS_ON_DEMAND}`;
    if (optIn[region] === 'not-opted-in') {
      return { region, status: 'not-enabled' as const, summary: 'Opt-in region — not switched on for your account', quotas: [], spot: null, spotReady: null,
        fix: { steps: ['AWS console → your account name (top right) → Account → "AWS Regions".', `Find ${region} and click "Enable" (takes a few minutes).`, 'Then request GPU quota there (new regions start at 0).'],
          consoleUrl: 'https://console.aws.amazon.com/billing/home#/account', consoleLabel: 'Open Account → AWS Regions',
          cli: `aws account enable-region --region-name ${region}` } };
    }
    // Which of our instance types AWS sells here (asked live; skipped if it can't be read).
    const allModels = uniq(AWS_SHAPES.map((sh) => sh.gpuModel));
    let notSold: string[] = [];
    try {
      const offered: Set<string> = await provider.getGpuTypesOffered(region);
      const sold = allModels.filter((m) => AWS_SHAPES.some((sh) => sh.gpuModel === m && offered.has(sh.id)));
      void applyOffering('aws', region, sold, allModels); // live answer corrects the catalog (Recon, launch)
      if (!sold.length) return notOffered(region, 'AWS sells no g4dn (T4), g5 (A10G) or g6e (L40S) machines in this region', 'https://aws.amazon.com/ec2/instance-types/g4/', 'AWS G4dn instances');
      notSold = allModels.filter((m) => !sold.includes(m));
    } catch { /* unknown: assume the catalog is right */ }
    const withSold = (a: RegionAccess): RegionAccess => (notSold.length ? { ...a, notSold, summary: `${a.summary} · no ${notSold.join('/')} machines sold here` } : a);
    try {
      const [od, sp, awsPending] = await Promise.all([
        provider.getEc2Quota(region, AWS_ON_DEMAND),
        provider.getEc2Quota(region, AWS_SPOT).catch(() => null),
        provider.getQuotaRequests?.(region).catch(() => null) ?? null,
      ]);
      // What can I run: a machine needs its vCPUs within the limit (on-demand
      // or spot). Big screen uses the same quotas. AWS reports limits, not usage.
      const awsCell = (s: { vcpus: number }, m: RunMode): RunCell => {
        const code = isSpotMode(m) ? AWS_SPOT : AWS_ON_DEMAND;
        const lim = isSpotMode(m) ? sp : od;
        if (lim == null) return { ok: null, why: 'Couldn’t read the spot quota', uses: [code] };
        return lim >= s.vcpus
          ? { ok: true, why: `Limit ${lim} vCPUs (a machine uses ${s.vcpus})`, uses: [code] }
          : { ok: false, why: `Limit ${lim} vCPUs — needs ${s.vcpus}`, uses: [code] };
      };
      const pend = (code: string) => (awsPending || []).filter((x: any) => x.quota === code).map((x: any) => ({ requested: x.requested, status: x.status, created: x.created }));
      const awsQ = (code: string, label: string, limit: number | null): QuotaDetail => {
        const short = (limit ?? 0) < AWS_MIN;
        const want = Math.max(8, (limit ?? 0) + AWS_MIN);
        return { key: code, label, used: null, limit: limit ?? 0, unit: 'vCPUs', unlocks: [], short,
          ...(short ? { request: {
            consoleUrl: `https://${region}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas/${code}`, consoleLabel: 'Request in Service Quotas',
            cli: `aws service-quotas request-service-quota-increase --region ${region} --service-code ec2 --quota-code ${code} --desired-value ${want}`,
            note: `Asks for ${want} vCPUs (two small machines, or one 8-vCPU). Run in AWS CloudShell.`,
          } } : {}),
          ...(pend(code).length ? { pending: pend(code) } : {}) };
      };
      const extra = {
        ...buildRun(AWS_SHAPES, (g) => !notSold.includes(g), true, awsCell,
          [awsQ(AWS_ON_DEMAND, 'Running On-Demand G and VT instances (vCPUs)', od), awsQ(AWS_SPOT, 'All G and VT Spot Instance Requests (vCPUs)', sp)]),
        ...(awsPending ? {} : { pendingNote: 'Couldn’t read open quota requests (the key needs “ServiceQuotasReadOnlyAccess”).' }),
      };
      const quotas: QuotaLine[] = [{ label: 'G and VT on-demand vCPUs', limit: od, used: 0, unit: 'vCPUs' }];
      const spot: QuotaLine | null = sp == null ? null : { label: 'G and VT spot vCPUs', limit: sp, used: 0, unit: 'vCPUs' };
      const cli = `aws service-quotas request-service-quota-increase --region ${region} --service-code ec2 --quota-code ${AWS_ON_DEMAND} --desired-value 8\n` +
        `aws service-quotas request-service-quota-increase --region ${region} --service-code ec2 --quota-code ${AWS_SPOT} --desired-value 8   # spot`;
      const spotReady = sp == null ? null : sp >= AWS_MIN;
      if (od < AWS_MIN && spotReady) {
        // Spot machines use their own quota: this region works for spot.
        return withSold({ region, status: 'ready' as const, onDemandReady: false, summary: `Spot only: ${sp} spot GPU vCPUs · on-demand quota is ${od}`, quotas, ...extra, spot, spotReady,
          fix: { steps: [`Spot machines can launch here. For on-demand ones: Service Quotas → EC2 → "Running On-Demand G and VT instances" in ${region} → Request increase → 8.`],
            consoleUrl: quotasUrl, consoleLabel: 'Request on-demand quota', cli } });
      }
      if (od < AWS_MIN) {
        return withSold({ region, status: 'no-quota' as const, onDemandReady: false, summary: `GPU quota is ${od} vCPUs on-demand${sp == null ? '' : `, ${sp} spot`} (a machine needs ${AWS_MIN})`, quotas, ...extra, spot, spotReady,
          fix: { steps: [`Service Quotas → EC2 → "Running On-Demand G and VT instances" in ${region} → Request increase → 8.`, 'For spot machines also "All G and VT Spot Instance Requests" → 8.', 'Approval: minutes to a couple of days.'],
            consoleUrl: quotasUrl, consoleLabel: 'Request quota', cli } });
      }
      return withSold({ region, status: 'ready' as const, onDemandReady: true, summary: `${od} GPU vCPUs on-demand${sp == null ? '' : ` · ${sp} spot`} (${Math.floor(od / AWS_MIN)} small machine${Math.floor(od / AWS_MIN) === 1 ? '' : 's'})`, quotas, ...extra, spot, spotReady });
    } catch (error) {
      const r = unknown(region, error, 'aws');
      if (/AccessDenied|not authorized|servicequotas/i.test(String((error as any)?.code || (error as any)?.message))) {
        r.summary = 'Your key can\'t read quotas — launching may still work';
        r.fix = { steps: ['Optional: attach "ServiceQuotasReadOnlyAccess" to the IAM user so the app can see your quotas.', `Or check "Running On-Demand G and VT instances" in ${region} yourself (button).`], consoleUrl: quotasUrl, consoleLabel: 'Open Service Quotas' };
      }
      return r;
    }
  }));
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------
const AZ_MIN = Math.min(...AZURE_SHAPES.map((s) => s.vcpus));

async function azureAccess(provider: any, regionIds: string[], log: Log = noLog): Promise<RegionAccess[]> {

  return mapLimit(regionIds, 4, verdict('azure', log, async (region): Promise<RegionAccess> => {
    // Does Azure sell our T4 sizes here, and to this subscription? (Asked live.)
    try {
      const sizes: Record<string, { restricted?: string }> = await provider.getSizeAvailability(region);
      const listed = Object.values(sizes);
      void applyOffering('azure', region, listed.length ? ['T4'] : [], ['T4']); // live answer corrects the catalog
      if (!listed.length) return notOffered(region, 'Azure sells no NCasT4_v3 (T4) machines in this region', 'https://azure.microsoft.com/explore/global-infrastructure/products-by-region/', 'Azure products by region');
      if (listed.every((x) => x.restricted)) {
        return { region, status: 'not-enabled' as const, summary: `Azure holds the T4 sizes back for your subscription here (${listed[0].restricted})`, quotas: [], spot: null, spotReady: null,
          fix: { steps: ['Portal → Help + support → Create a support request → Service and subscription limits (quotas) → Compute-VM (cores-vCPUs).', `Ask for access to "NCASv3_T4" in ${region} (new limit 8). Microsoft reviews it by hand.`, 'Meanwhile use a nearby region that shows Ready or No quota.'],
            consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request',
            cli: `az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table` } };
      }
    } catch { /* unknown: carry on with the quota check */ }
    try {
      const [usage, azPending]: [Array<{ name: string; limit: number; current: number }>, any[] | null] = await Promise.all([
        provider.getComputeUsage(region),
        provider.getQuotaRequests?.(region).catch(() => null) ?? null,
      ]);
      const find = (n: string) => usage.find((u) => u.name.toLowerCase() === n.toLowerCase());
      // The T4 family's quota (Azure names it standardNCASv3_T4Family; match loosely in case the casing/format differs).
      const fam = find(T4_QUOTA_FAMILY) || usage.find((u) => /ncasv3_?t4/i.test(u.name));
      const total = find('cores');
      const spotU = find('lowPriorityCores');
      const line = (label: string, u?: { limit: number; current: number }): QuotaLine => ({ label, limit: u?.limit || 0, used: u?.current || 0, unit: 'vCPUs' });
      const quotas = [line('NCASv3_T4 family vCPUs (on-demand)', fam), line('Total regional vCPUs (on-demand)', total)];
      const spot = spotU ? line('Spot (low-priority) vCPUs', spotU) : null;
      // Spot machines count ONLY against the spot quota ("Total Regional
      // Low-priority vCPUs"), not the T4 family or regional totals.
      const spotFree = spot ? spot.limit - spot.used : 0;
      const spotReady = spot ? spotFree >= AZ_MIN : null;
      const famFree = fam ? fam.limit - fam.current : 0;
      const totFree = total ? total.limit - total.current : Infinity;
      const onDemandReady = !!fam && famFree >= AZ_MIN && totFree >= AZ_MIN;
      const quotasUrl = `https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas`;
      const odFix = !fam
        ? { steps: [
            `Check the machines exist here: az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table (Restrictions should be "None").`,
            'Portal → Help + support → Create a support request → Service and subscription limits (quotas) → Compute-VM (cores-vCPUs) subscription limit increases.',
            `Region ${region}, series "NCASv3_T4", new limit 8. Microsoft reviews it by hand (usually a few days).`,
          ], consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request',
            cli: `az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table` }
        : { steps: [`Quotas → Compute → filter region ${region} → "Standard NCASv3_T4 Family vCPUs" → request 8 (and "Total Regional vCPUs" ≥ 8).`, 'Auto-approved in minutes where Azure has capacity; otherwise follow up with a support request.'],
            consoleUrl: quotasUrl, consoleLabel: 'Open Quotas',
            cli: `az extension add --name quota --only-show-errors\naz quota update --resource-name ${T4_QUOTA_FAMILY} --resource-type dedicated --scope "/subscriptions/${String(provider.subscriptionId || '<subscription-id>')}/providers/Microsoft.Compute/locations/${region}" --limit-object value=8` };
      // What can I run: on-demand needs the vCPUs free in BOTH the T4 family
      // and the regional total; spot only in the spot (low-priority) quota.
      // Big screen uses the same quotas. Azure only has T4 machines (Good).
      const famKey = fam?.name || T4_QUOTA_FAMILY;
      const azCell = (s: { vcpus: number }, m: RunMode): RunCell => {
        if (isSpotMode(m)) {
          if (!spot) return { ok: null, why: 'Couldn’t read the spot quota', uses: ['lowPriorityCores'] };
          return spotFree >= s.vcpus ? { ok: true, why: `Spot vCPUs: ${spotFree} free (a machine uses ${s.vcpus})`, uses: ['lowPriorityCores'] }
            : spot.limit >= s.vcpus ? { ok: false, inUse: true, why: `Spot vCPUs: ${spot.used} of ${spot.limit} in use by your machines`, uses: ['lowPriorityCores'] }
            : { ok: false, why: `Spot vCPUs: limit ${spot.limit} — needs ${s.vcpus}`, uses: ['lowPriorityCores'] };
        }
        const uses = [famKey, 'cores'];
        if (!fam) return { ok: false, why: 'No T4 quota entry for your subscription here', uses };
        if (famFree < s.vcpus) return fam.limit >= s.vcpus
          ? { ok: false, inUse: true, why: `T4 family vCPUs: ${fam.current} of ${fam.limit} in use by your machines`, uses }
          : { ok: false, why: `T4 family vCPUs: limit ${fam.limit} — needs ${s.vcpus}`, uses };
        if (totFree < s.vcpus) return total && total.limit >= s.vcpus
          ? { ok: false, inUse: true, why: `Total regional vCPUs: ${total.current} of ${total.limit} in use by your machines`, uses }
          : { ok: false, why: `Total regional vCPUs: limit ${total?.limit ?? 0} — needs ${s.vcpus}`, uses };
        return { ok: true, why: `T4 family: ${famFree} free · regional: ${totFree === Infinity ? '?' : totFree} free`, uses };
      };
      const azPend = (key: string) => (azPending || []).filter((x) => String(x.quota).toLowerCase() === key.toLowerCase()).map((x) => ({ requested: x.requested, status: x.status, created: x.created }));
      const sub = String(provider.subscriptionId || '<subscription-id>');
      const azQ = (key: string, label: string, u?: { limit: number; current: number }, lowPriority = false): QuotaDetail => {
        const short = !u || u.limit - u.current < AZ_MIN;
        const want = Math.max(8, (u?.current || 0) + 8);
        const missingEntry = !u && !lowPriority && key !== 'cores';
        const request = !short ? undefined : missingEntry ? {
          consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request',
          cli: `az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table`,
          note: `No quota entry exists for this family here, so it can't be raised with a command: open a support request (Service and subscription limits → Compute-VM → ${region}, NCASv3_T4, new limit 8). The command checks whether the size is offered to you.`,
        } : {
          consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas', consoleLabel: 'Open Quotas',
          cli: `az quota update --resource-name ${key} --resource-type ${lowPriority ? 'lowPriority' : 'dedicated'} --scope "/subscriptions/${sub}/providers/Microsoft.Compute/locations/${region}" --limit-object value=${want}`,
          note: `Asks for ${want} vCPUs. Run in Azure Cloud Shell (first time: az extension add --name quota).`,
        };
        return { key, label, used: u ? u.current : 0, limit: u ? u.limit : 0, unit: 'vCPUs', unlocks: [], short, ...(request ? { request } : {}), ...(azPend(key).length ? { pending: azPend(key) } : {}) };
      };
      const extra = {
        ...buildRun(AZURE_SHAPES, () => true, true, azCell, [
          azQ(famKey, 'Standard NCASv3_T4 Family vCPUs (on-demand)', fam),
          azQ('cores', 'Total Regional vCPUs (on-demand)', total),
          azQ('lowPriorityCores', 'Total Regional Low-priority vCPUs (spot)', spotU, true),
        ]),
        pendingNote: azPending ? 'Requests made through a support ticket don’t show here — check Help + support → All support requests.' : 'Couldn’t read open quota requests.',
      };
      const inUse = (u?: { limit: number; current: number }) => !!u && u.limit >= AZ_MIN && u.limit - u.current < AZ_MIN;
      const odWhy = !fam ? 'no T4 on-demand quota entry for your subscription here'
        : famFree < AZ_MIN ? (inUse(fam) ? `T4 on-demand quota in use (${fam.current} of ${fam.limit} vCPUs used by your machines)` : `T4 on-demand quota is ${fam.limit} vCPUs`)
        : `"Total Regional vCPUs" ${inUse(total) ? `in use (${total!.current} of ${total!.limit})` : `is only ${total!.limit}`}`;
      if (onDemandReady) {
        return { region, status: 'ready' as const, onDemandReady: true, summary: `${famFree} T4 vCPUs free on-demand${spot ? ` · ${spotFree} spot` : ''} (${Math.floor(famFree / AZ_MIN)} small machine${Math.floor(famFree / AZ_MIN) === 1 ? '' : 's'})`, quotas, ...extra, spot, spotReady };
      }
      if (spotReady) {
        return { region, status: 'ready' as const, onDemandReady: false, summary: `Spot only: ${spotFree} spot vCPUs free · ${odWhy}`, quotas, ...extra, spot, spotReady,
          fix: { ...odFix, steps: ['Spot machines can launch here (they use the separate spot quota). For on-demand machines:', ...odFix.steps] } };
      }
      const spotWhy = !spot ? '' : inUse(spotU) ? ` · spot quota in use (${spot.used} of ${spot.limit} vCPUs)` : ` · spot quota ${spot.limit} vCPUs`;
      return { region, status: 'no-quota' as const, onDemandReady: false, summary: `${odWhy[0].toUpperCase()}${odWhy.slice(1)}${spotWhy} (a machine needs ${AZ_MIN})`, quotas, ...extra, spot, spotReady, fix: odFix };
    } catch (error) {
      const text = String((error as any)?.code || '') + String((error as any)?.message || '');
      if (/LocationNotAvailableForResourceType|NoRegisteredProviderFound|not available for subscription|InvalidLocation/i.test(text)) {
        return { region, status: 'not-enabled' as const, summary: 'Region not available to your subscription', quotas: [], spot: null, spotReady: null,
          fix: { steps: ['Open a support request → Service and subscription limits (quotas) → quota type "Region access" → this region.'], consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request' } };
      }
      return unknown(region, error, 'azure');
    }
  }));
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------
async function oracleAccess(provider: any, regionIds: string[], log: Log = noLog): Promise<RegionAccess[]> {
  let subscribed: string[] | null = null;
  try { subscribed = await provider.getSubscribedRegions(); } catch { /* unknown below */ }
  return mapLimit(regionIds, 3, verdict('oracle', log, async (region): Promise<RegionAccess> => {
    const limitsUrl = `https://cloud.oracle.com/limits?region=${region}`;
    if (subscribed && !subscribed.includes(region)) {
      return { region, status: 'not-enabled' as const, summary: 'Region not subscribed in your tenancy', quotas: [], spot: null, spotReady: null,
        fix: { steps: ['Oracle console → region menu (top) → "Manage regions".', `Find ${region} and click "Subscribe" (free; takes a few minutes).`, 'Then request a GPU limit there (it starts at 0).'],
          consoleUrl: 'https://cloud.oracle.com/regions/infrastructure', consoleLabel: 'Manage regions' } };
    }
    try {
      const lim = await provider.getGpuLimit(region);
      void applyOffering('oracle', region, lim ? ['A10'] : [], ['A10']); // live answer corrects the catalog
      if (!lim) return notOffered(region, 'Oracle lists no A10 GPU limit here, so it doesn’t sell A10 machines in this region', 'https://docs.oracle.com/iaas/Content/Compute/References/computeshapes.htm', 'Oracle GPU shapes');
      // What can I run: 1 A10 GPU per machine; preemptible (spot) machines
      // count against the same limit. No big screen on Oracle.
      const ociFree = lim.limit - lim.used;
      const ociCell = (): RunCell => ociFree >= 1 ? { ok: true, why: `${ociFree} A10 GPU${ociFree === 1 ? '' : 's'} free`, uses: ['A10'] }
        : lim.limit > 0 ? { ok: false, inUse: true, why: `All ${lim.limit} A10 GPU${lim.limit === 1 ? '' : 's'} in use by your machines`, uses: ['A10'] }
        : { ok: false, why: 'A10 GPU limit is 0', uses: ['A10'] };
      const extra = {
        ...buildRun(ORACLE_SHAPES, () => true, false, ociCell, [{ key: 'A10', label: 'GPU.A10 GPUs (normal and preemptible)', used: lim.used, limit: lim.limit, unit: 'GPUs', unlocks: [],
          short: ociFree < 1,
          ...(ociFree < 1 ? { request: { consoleUrl: limitsUrl, consoleLabel: 'Open Limits', note: 'Search "GPU.A10" → "Request a service limit increase" → 1 per availability domain. Oracle has no command for this (it opens a support request).' } } : {}) }]),
        pendingNote: 'Oracle limit increases are support requests, which the app can’t see — check Help → Support requests in the Oracle console.',
      };
      if (lim.limit - lim.used < 1) {
        return { region, status: 'no-quota' as const, summary: lim.limit > 0 ? `All ${lim.limit} A10 GPU${lim.limit === 1 ? '' : 's'} in use by your machines — stop one, or request more` : `A10 GPU limit is ${lim.limit}`, quotas: [{ label: 'A10 GPUs', limit: lim.limit, used: lim.used, unit: 'GPUs' as const }], ...extra, spot: null, spotReady: null,
          fix: { steps: ['Governance → Limits, Quotas and Usage → Service "Compute" → search "GPU.A10".', 'Click "Request a service limit increase" → 1 (per availability domain).', 'Approval: hours to a couple of days.'],
            consoleUrl: limitsUrl, consoleLabel: 'Open Limits',
            cli: `oci limits value list --service-name compute --compartment-id ${String(provider.tenancyOcid || '<tenancy-ocid>')} --region ${region} --all --query "data[?contains(name,'a10')]" --output table` } };
      }
      return { region, status: 'ready' as const, summary: `${lim.limit - lim.used} A10 GPU${lim.limit - lim.used === 1 ? '' : 's'} available`, quotas: [{ label: 'A10 GPUs', limit: lim.limit, used: lim.used, unit: 'GPUs' }], ...extra, spot: null, spotReady: null };
    } catch (error) {
      return unknown(region, error, 'oracle');
    }
  }));
}

export const CHECKERS: Record<ProviderName, (provider: any, regions: string[], log?: Log) => Promise<RegionAccess[]>> = {
  gcp: gcpAccess, aws: awsAccess, azure: azureAccess, oracle: oracleAccess,
};

/** Access for every cloud (connected or not) and every catalog region. */
export async function getRegionAccess(userId: string, refresh = false, log: Log = noLog): Promise<{ generatedAt: string; clouds: CloudAccess[] }> {
  const creds = await listCredentialSummaries(userId);
  const connected = new Set(creds.map((c) => c.provider).filter(isProviderName));

  const clouds = await Promise.all(Object.values(CATALOGS).map(async (catalog): Promise<CloudAccess> => {
    const base = { provider: catalog.provider, label: catalog.label };
    const withCoords = (list: RegionAccess[]) => list.map((a) => {
      const r = catalog.regions.find((x) => x.id === a.region)!;
      return { ...a, name: r.name, lat: r.lat, lng: r.lng };
    });
    // Every catalog region is listed even when it can't be checked, so the
    // page can show the whole footprint ("this would work once connected").
    const placeholder = (status: RegionStatus, summary: string) => withCoords(catalog.regions.map((r) => ({ region: r.id, status, summary, quotas: [], spot: null, spotReady: null })));
    const tag = SHORT[catalog.provider].padEnd(5);
    if (!connected.has(catalog.provider)) {
      log('info', `${tag}   no keys saved — skipped (${catalog.regions.length} regions shown as "No keys")`);
      return { ...base, connected: false, checkedAt: new Date().toISOString(), regions: placeholder('not-connected', `Add your ${catalog.label} keys on Config to check this region`) };
    }
    const key = `${userId}:${catalog.provider}`;
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) {
      log('info', `${tag}   using the check from ${Math.max(1, Math.round((Date.now() - hit.at) / 60000))} min ago (kept 10 min) — press Re-check to ask ${catalog.label} again`);
      return hit.value;
    }
    let value: CloudAccess;
    const t0 = Date.now();
    log('info', `${tag}   ${catalog.label}: checking ${catalog.regions.length} regions with your saved key…`);
    try {
      const provider = traced(await providerFor(userId, catalog.provider), catalog.provider, log);
      const list = await CHECKERS[catalog.provider](provider, catalog.regions.map((r) => r.id), log);
      value = { ...base, connected: true, checkedAt: new Date().toISOString(), regions: withCoords(list) };
      const n = (st: RegionStatus) => list.filter((a) => a.status === st).length;
      log('ok', `${tag}   ${catalog.label} done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${n('ready')} ready · ${n('no-quota')} no quota · ${n('not-enabled')} not enabled · ${n('not-offered')} not sold · ${n('unknown')} unchecked`);
    } catch (error) {
      value = { ...base, connected: true, checkedAt: new Date().toISOString(), error: toFriendlyError(error, catalog.provider), regions: [] };
      value.regions = placeholder('unknown', `Couldn't check: ${value.error!.title}`);
      log('err', `${tag}   ${catalog.label}: couldn't check — ${value.error!.title}`);
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  }));
  return { generatedAt: new Date().toISOString(), clouds };
}


// ---------------------------------------------------------------------------
// Checks with a live log: POST starts one, GET polls its new lines.
// Kept in memory for 10 minutes (one server instance).
// ---------------------------------------------------------------------------
interface LiveCheck {
  userId: string; startedAt: number; done: boolean;
  lines: Array<{ i: number; ms: number; level: LogLevel; text: string }>;
  result?: { generatedAt: string; clouds: CloudAccess[] }; error?: string;
}
const liveChecks = new Map<string, LiveCheck>();

export function startRegionCheck(userId: string, refresh: boolean): string {
  for (const [k, v] of liveChecks) if (Date.now() - v.startedAt > 10 * 60_000) liveChecks.delete(k);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const check: LiveCheck = { userId, startedAt: Date.now(), done: false, lines: [] };
  liveChecks.set(id, check);
  const log: Log = (level, text) => { if (check.lines.length < 5000) check.lines.push({ i: check.lines.length + 1, ms: Date.now() - check.startedAt, level, text }); };
  log('info', `Asking your clouds where you can launch a GPU machine${refresh ? ' (fresh check)' : ''}…`);
  getRegionAccess(userId, refresh, log)
    .then((r) => { check.result = r; log('ok', `All done in ${((Date.now() - check.startedAt) / 1000).toFixed(1)} s.`); })
    .catch((e) => { check.error = String(e?.message || e); log('err', `Failed: ${check.error}`); })
    .finally(() => { check.done = true; });
  return id;
}

export function readRegionCheck(userId: string, id: string, after: number) {
  const c = liveChecks.get(id);
  if (!c || c.userId !== userId) return null;
  return { done: c.done, lines: c.lines.filter((l) => l.i > after), result: c.done ? c.result : undefined, error: c.error };
}
