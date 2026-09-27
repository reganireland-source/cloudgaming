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
 *                regions, Oracle region subscriptions)
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
import { GCP_SHAPES } from '../providers/gcp/catalog';
import { AZURE_SHAPES, T4_QUOTA_FAMILY } from '../providers/azure/catalog';

export type RegionStatus = 'ready' | 'no-quota' | 'not-enabled' | 'unknown' | 'not-connected';

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
  /** Ready overall, but these GPU models have no free quota (GCP quotas are per GPU: T4 vs L4). */
  missingGpus?: string[];
  fix?: { steps: string[]; consoleUrl?: string; consoleLabel?: string; cli?: string };
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
// Google Cloud
// ---------------------------------------------------------------------------
async function gcpAccess(provider: any, regionIds: string[]): Promise<RegionAccess[]> {
  const project = await provider.getProject();
  const pid = provider.projectId;
  const globalLimit = Number((project.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.limit) || 0;
  const globalUsage = Number((project.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS')?.usage) || 0;
  const quotasUrl = `https://console.cloud.google.com/iam-admin/quotas?project=${pid}`;
  const metrics = Array.from(new Set(GCP_SHAPES.map((s) => s.gpuQuotaMetric)));   // NVIDIA_T4_GPUS, NVIDIA_L4_GPUS

  return mapLimit(regionIds, 5, async (region) => {
    try {
      const q = await provider.getRegionQuotas(region);
      const line = (metric: string): QuotaLine => {
        const m = q.find((x: any) => x.metric === metric);
        return { label: metric.replace(/_/g, ' ').replace('NVIDIA ', 'NVIDIA ').replace(' GPUS', ' GPUs').replace('PREEMPTIBLE ', 'Spot '), limit: m?.limit || 0, used: m?.usage || 0, unit: 'GPUs' };
      };
      const quotas = [{ label: 'GPUs (all regions)', limit: globalLimit, used: globalUsage, unit: 'GPUs' as const }, ...metrics.map(line)];
      const regional = metrics.map(line).filter((l) => l.limit - l.used >= 1);
      const spotLines = metrics.map((m) => line('PREEMPTIBLE_' + m));
      const spotOk = spotLines.some((l) => l.limit - l.used >= 1);
      const bestSpot = spotLines.sort((a, b) => b.limit - a.limit)[0] || null;
      const cli = `gcloud beta quotas preferences create --project=${pid} --service=compute.googleapis.com \\\n  --quota-id=<ID from: gcloud beta quotas info list --service=compute.googleapis.com --project=${pid} --filter="quotaId~GPU" --format="value(quotaId)"> \\\n  --preferred-value=1 --dimensions=region=${region} --email=<you> --justification="Personal cloud gaming VM"`;
      if (globalLimit - globalUsage < 1) {
        return { region, status: 'no-quota', summary: 'Project allows 0 GPUs in total ("GPUs (all regions)")', quotas, spot: bestSpot, spotReady: false,
          fix: { steps: ['Request "GPUs (all regions)" = 1 (once for the whole project).', `Also request "NVIDIA T4 GPUs" or "NVIDIA L4 GPUs" = 1 in ${region}.`, 'Free-trial accounts must "Activate full account" first.'],
            consoleUrl: `${quotasUrl}&metric=compute.googleapis.com%2Fgpus_all_regions`, consoleLabel: 'Request GPU quota', cli } };
      }
      if (!regional.length) {
        return { region, status: 'no-quota', summary: `No T4 or L4 GPU quota in ${region}`, quotas, spot: bestSpot, spotReady: spotOk,
          fix: { steps: [`On the Quotas page, filter "NVIDIA T4 GPUs" (cheapest) or "NVIDIA L4 GPUs", pick ${region}, request 1.`, 'For spot machines also request the "Preemptible" version.', 'Approval: minutes to 2 business days.'],
            consoleUrl: quotasUrl, consoleLabel: 'Open Quotas', cli } };
      }
      const missingGpus = metrics.filter((m) => { const l = line(m); return l.limit - l.used < 1; })
        .map((m) => GCP_SHAPES.find((sh) => sh.gpuQuotaMetric === m)!.gpuModel);
      return { region, status: 'ready', summary: regional.map((l) => `${l.label.replace('NVIDIA ', '')}: ${l.limit - l.used} free`).join(' · '), quotas, spot: bestSpot, spotReady: spotOk, missingGpus,
        ...(missingGpus.length ? { fix: { steps: [`Only ${regional.map((l) => l.label.replace('NVIDIA ', '')).join(' and ')} can launch here. For ${missingGpus.join('/')} machines, request "NVIDIA ${missingGpus[0]} GPUs" = 1 in ${region}.`], consoleUrl: quotasUrl, consoleLabel: 'Request GPU quota', cli } } : {}) };
    } catch (error) {
      return unknown(region, error, 'gcp');
    }
  });
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------
const AWS_ON_DEMAND = 'L-DB2E81BA'; // Running On-Demand G and VT instances (vCPUs)
const AWS_SPOT = 'L-3819A6DF';      // All G and VT Spot Instance Requests (vCPUs)
const AWS_MIN = 4;

async function awsAccess(provider: any, regionIds: string[]): Promise<RegionAccess[]> {
  let optIn: Record<string, string> = {};
  try { optIn = await provider.getRegionOptIn(); } catch { /* treat as unknown below */ }
  return mapLimit(regionIds, 4, async (region) => {
    const quotasUrl = `https://${region}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas/${AWS_ON_DEMAND}`;
    if (optIn[region] === 'not-opted-in') {
      return { region, status: 'not-enabled' as const, summary: 'Opt-in region — not switched on for your account', quotas: [], spot: null, spotReady: null,
        fix: { steps: ['AWS console → your account name (top right) → Account → "AWS Regions".', `Find ${region} and click "Enable" (takes a few minutes).`, 'Then request GPU quota there (new regions start at 0).'],
          consoleUrl: 'https://console.aws.amazon.com/billing/home#/account', consoleLabel: 'Open Account → AWS Regions',
          cli: `aws account enable-region --region-name ${region}` } };
    }
    try {
      const [od, sp] = await Promise.all([
        provider.getEc2Quota(region, AWS_ON_DEMAND),
        provider.getEc2Quota(region, AWS_SPOT).catch(() => null),
      ]);
      const quotas: QuotaLine[] = [{ label: 'G and VT on-demand vCPUs', limit: od, used: 0, unit: 'vCPUs' }];
      const spot: QuotaLine | null = sp == null ? null : { label: 'G and VT spot vCPUs', limit: sp, used: 0, unit: 'vCPUs' };
      const cli = `aws service-quotas request-service-quota-increase --region ${region} --service-code ec2 --quota-code ${AWS_ON_DEMAND} --desired-value 8\n` +
        `aws service-quotas request-service-quota-increase --region ${region} --service-code ec2 --quota-code ${AWS_SPOT} --desired-value 8   # spot`;
      if (od < AWS_MIN) {
        return { region, status: 'no-quota' as const, summary: `GPU quota is ${od} vCPUs (a machine needs ${AWS_MIN})`, quotas, spot, spotReady: sp == null ? null : sp >= AWS_MIN,
          fix: { steps: [`Service Quotas → EC2 → "Running On-Demand G and VT instances" in ${region} → Request increase → 8.`, 'For spot machines also "All G and VT Spot Instance Requests" → 8.', 'Approval: minutes to a couple of days.'],
            consoleUrl: quotasUrl, consoleLabel: 'Request quota', cli } };
      }
      return { region, status: 'ready' as const, summary: `${od} GPU vCPUs (${Math.floor(od / AWS_MIN)} small machine${Math.floor(od / AWS_MIN) === 1 ? '' : 's'})`, quotas, spot, spotReady: sp == null ? null : sp >= AWS_MIN };
    } catch (error) {
      const r = unknown(region, error, 'aws');
      if (/AccessDenied|not authorized|servicequotas/i.test(String((error as any)?.code || (error as any)?.message))) {
        r.summary = 'Your key can\'t read quotas — launching may still work';
        r.fix = { steps: ['Optional: attach "ServiceQuotasReadOnlyAccess" to the IAM user so the app can see your quotas.', `Or check "Running On-Demand G and VT instances" in ${region} yourself (button).`], consoleUrl: quotasUrl, consoleLabel: 'Open Service Quotas' };
      }
      return r;
    }
  });
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------
const AZ_MIN = Math.min(...AZURE_SHAPES.map((s) => s.vcpus));

async function azureAccess(provider: any, regionIds: string[]): Promise<RegionAccess[]> {

  return mapLimit(regionIds, 4, async (region) => {
    const cliBase = `SUB=$(az account show --query id -o tsv)\n`;
    try {
      const usage: Array<{ name: string; limit: number; current: number }> = await provider.getComputeUsage(region);
      const find = (n: string) => usage.find((u) => u.name.toLowerCase() === n.toLowerCase());
      const fam = find(T4_QUOTA_FAMILY);
      const total = find('cores');
      const spotU = find('lowPriorityCores');
      const line = (label: string, u?: { limit: number; current: number }): QuotaLine => ({ label, limit: u?.limit || 0, used: u?.current || 0, unit: 'vCPUs' });
      const quotas = [line('NCASv3_T4 family vCPUs', fam), line('Total regional vCPUs', total)];
      const spot = spotU ? line('Spot vCPUs', spotU) : null;
      const spotReady = spot ? spot.limit - spot.used >= AZ_MIN : null;
      const quotasUrl = `https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas`;
      if (!fam) {
        return { region, status: 'no-quota' as const, summary: 'No T4 quota entry for your subscription here — needs a support request', quotas, spot, spotReady,
          fix: { steps: [
            `Check the machines exist here: az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table (Restrictions should be "None").`,
            'Portal → Help + support → Create a support request → Service and subscription limits (quotas) → Compute-VM (cores-vCPUs) subscription limit increases.',
            `Region ${region}, series "NCASv3_T4", new limit 8. Microsoft reviews it by hand (usually a few days).`,
          ], consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request',
            cli: `az vm list-skus --location ${region} --size Standard_NC4as_T4_v3 --all -o table` } };
      }
      const famFree = fam.limit - fam.current;
      const totFree = total ? total.limit - total.current : Infinity;
      if (famFree < AZ_MIN || totFree < AZ_MIN) {
        const which = famFree < AZ_MIN ? `NCASv3_T4 family quota is ${fam.limit} vCPUs` : `"Total Regional vCPUs" is only ${total!.limit}`;
        return { region, status: 'no-quota' as const, summary: `${which} (a machine needs ${AZ_MIN})`, quotas, spot, spotReady,
          fix: { steps: [`Quotas → Compute → filter region ${region} → "Standard NCASv3_T4 Family vCPUs" → request 8 (and "Total Regional vCPUs" ≥ 8).`, 'Auto-approved in minutes where Azure has capacity; otherwise follow up with a support request.'],
            consoleUrl: quotasUrl, consoleLabel: 'Open Quotas',
            cli: `${cliBase}az extension add --name quota\naz quota update --resource-name ${T4_QUOTA_FAMILY} --resource-type dedicated \\\n  --scope "/subscriptions/$SUB/providers/Microsoft.Compute/locations/${region}" --limit-object value=8` } };
      }
      return { region, status: 'ready' as const, summary: `${famFree} T4 vCPUs free (${Math.floor(famFree / AZ_MIN)} small machine${Math.floor(famFree / AZ_MIN) === 1 ? '' : 's'})`, quotas, spot, spotReady };
    } catch (error) {
      const text = String((error as any)?.code || '') + String((error as any)?.message || '');
      if (/LocationNotAvailableForResourceType|NoRegisteredProviderFound|not available for subscription|InvalidLocation/i.test(text)) {
        return { region, status: 'not-enabled' as const, summary: 'Region not available to your subscription', quotas: [], spot: null, spotReady: null,
          fix: { steps: ['Open a support request → Service and subscription limits (quotas) → quota type "Region access" → this region.'], consoleUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Support/NewSupportRequestV3Blade', consoleLabel: 'New support request' } };
      }
      return unknown(region, error, 'azure');
    }
  });
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------
async function oracleAccess(provider: any, regionIds: string[]): Promise<RegionAccess[]> {
  let subscribed: string[] | null = null;
  try { subscribed = await provider.getSubscribedRegions(); } catch { /* unknown below */ }
  return mapLimit(regionIds, 3, async (region) => {
    const limitsUrl = `https://cloud.oracle.com/limits?region=${region}`;
    if (subscribed && !subscribed.includes(region)) {
      return { region, status: 'not-enabled' as const, summary: 'Region not subscribed in your tenancy', quotas: [], spot: null, spotReady: null,
        fix: { steps: ['Oracle console → region menu (top) → "Manage regions".', `Find ${region} and click "Subscribe" (free; takes a few minutes).`, 'Then request a GPU limit there (it starts at 0).'],
          consoleUrl: 'https://cloud.oracle.com/regions/infrastructure', consoleLabel: 'Manage regions' } };
    }
    try {
      const lim = await provider.getGpuLimit(region);
      if (!lim || lim.limit - lim.used < 1) {
        return { region, status: 'no-quota' as const, summary: lim ? `A10 GPU limit is ${lim.limit}` : 'No A10 GPU limit listed here', quotas: lim ? [{ label: 'A10 GPUs', limit: lim.limit, used: lim.used, unit: 'GPUs' as const }] : [], spot: null, spotReady: null,
          fix: { steps: ['Governance → Limits, Quotas and Usage → Service "Compute" → search "GPU.A10".', 'Click "Request a service limit increase" → 1 (per availability domain).', 'Approval: hours to a couple of days.'],
            consoleUrl: limitsUrl, consoleLabel: 'Open Limits',
            cli: `oci limits value list --service-name compute --compartment-id <tenancy-ocid> --region ${region} --all --query "data[?contains(name,'a10')]" --output table` } };
      }
      return { region, status: 'ready' as const, summary: `${lim.limit - lim.used} A10 GPU${lim.limit - lim.used === 1 ? '' : 's'} available`, quotas: [{ label: 'A10 GPUs', limit: lim.limit, used: lim.used, unit: 'GPUs' }], spot: null, spotReady: null };
    } catch (error) {
      return unknown(region, error, 'oracle');
    }
  });
}

const CHECKERS: Record<ProviderName, (provider: any, regions: string[]) => Promise<RegionAccess[]>> = {
  gcp: gcpAccess, aws: awsAccess, azure: azureAccess, oracle: oracleAccess,
};

/** Access for every cloud (connected or not) and every catalog region. */
export async function getRegionAccess(userId: string, refresh = false): Promise<{ generatedAt: string; clouds: CloudAccess[] }> {
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
    if (!connected.has(catalog.provider)) {
      return { ...base, connected: false, checkedAt: new Date().toISOString(), regions: placeholder('not-connected', `Add your ${catalog.label} keys on Config to check this region`) };
    }
    const key = `${userId}:${catalog.provider}`;
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value: CloudAccess;
    try {
      const provider = await providerFor(userId, catalog.provider);
      const list = await CHECKERS[catalog.provider](provider, catalog.regions.map((r) => r.id));
      value = { ...base, connected: true, checkedAt: new Date().toISOString(), regions: withCoords(list) };
    } catch (error) {
      value = { ...base, connected: true, checkedAt: new Date().toISOString(), error: toFriendlyError(error, catalog.provider), regions: [] };
      value.regions = placeholder('unknown', `Couldn't check: ${value.error!.title}`);
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  }));
  return { generatedAt: new Date().toISOString(), clouds };
}
