/**
 * ============================================================================
 * src/providers/gcp/checks.ts — "ADD GOOGLE CLOUD" FORM + LIVE CHECKS
 * ============================================================================
 *
 * When someone adds Google Cloud credentials on the Config page, runChecks()
 * goes through this list and reports each result with a tip:
 *
 *   1. format     — is it a real service-account JSON key?
 *   2. key        — can the private key inside it be read?
 *   3. project    — does the Project ID match the key's project?
 *   4. signin     — does Google accept the key, and can it see the project?
 *                   (also catches "Compute Engine API disabled", billing...)
 *   5. gpu-global — "GPUs (all regions)" quota ≥ 1?
 *   6. gpu-region — T4/L4 quota ≥ 1 in the chosen region?
 *   7. network    — does the "default" network exist?
 *
 * Checks 1–4 are FAILS (nothing is saved). 5–7 are WARNINGS: the key is
 * fine and is saved, but launching won't work until they're fixed — common
 * while a quota request is still waiting for approval.
 * ============================================================================
 */

import crypto from 'crypto';
import { GCPProvider } from '../GCPProvider';
import { toFriendlyError } from '../errors';
import { CredentialCheck, ProviderSetupModule, outcome } from '../shared/types';
import { DEFAULT_REGION, GCP_SHAPES, findRegion } from './catalog';

function consoleUrl(path: string, project?: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://console.cloud.google.com/${path}${project ? `${sep}project=${project}` : ''}`;
}

export const GCP_SETUP: ProviderSetupModule = {
  intro:
    'Paste (or upload) the JSON key of a service account with the "Compute Admin" role. Machines are created in YOUR project and billed to you by Google.',
  fields: [
    {
      key: 'projectId',
      label: 'Project ID',
      type: 'text',
      required: false,
      placeholder: 'my-gaming-412305',
      help: 'Optional — read from the key file if left blank. It\'s the ID, not the display name.',
    },
    {
      key: 'serviceAccountKey',
      label: 'Service account key (JSON)',
      type: 'file-text',
      required: true,
      accept: '.json,application/json',
      placeholder: '{ "type": "service_account", "project_id": "…", "private_key": "-----BEGIN PRIVATE KEY-----…", … }',
      help: 'IAM & Admin → Service Accounts → your account → Keys → Add key → JSON. Upload or paste the whole file.',
      secret: true,
    },
  ],

  async runChecks(input, opts) {
    const checks: CredentialCheck[] = [];
    const region = findRegion(opts.region || '')?.id || DEFAULT_REGION;

    // 1. Format
    let creds;
    try {
      creds = GCPProvider.parseCredentials({ projectId: input.projectId, serviceAccountKey: input.serviceAccountKey });
      checks.push({ id: 'format', label: 'Key file format', status: 'pass', message: `Service account ${creds.clientEmail}` });
    } catch (error) {
      const f = toFriendlyError(error, 'gcp');
      checks.push({ id: 'format', label: 'Key file format', status: 'fail', message: f.title, tip: f.fixes.join(' ') });
      return outcome(checks, undefined, {});
    }

    // 2. Private key readable
    try {
      crypto.createPrivateKey(creds.privateKey);
      checks.push({ id: 'key', label: 'Private key', status: 'pass', message: 'The private key inside the file is readable.' });
    } catch {
      checks.push({
        id: 'key', label: 'Private key', status: 'fail',
        message: 'The "private_key" in the file is damaged.',
        tip: 'Its line breaks must stay as \\n. Upload the original .json file instead of pasting, or create a new key.',
      });
      return outcome(checks, undefined, { projectId: creds.projectId, clientEmail: creds.clientEmail });
    }

    // 3. Project matches the key
    let keyProject = '';
    try {
      keyProject = JSON.parse(input.serviceAccountKey).project_id || '';
    } catch { /* already validated above */ }
    if (keyProject && keyProject !== creds.projectId) {
      checks.push({
        id: 'project', label: 'Project ID', status: 'warn',
        message: `You entered "${creds.projectId}" but the key belongs to "${keyProject}".`,
        tip: 'That only works if the service account was also granted roles in the other project. Usually, leave Project ID blank.',
      });
    } else {
      checks.push({ id: 'project', label: 'Project ID', status: 'pass', message: `Project ${creds.projectId}` });
    }

    const metadata = {
      projectId: creds.projectId,
      clientEmail: creds.clientEmail,
      keyId: (() => { try { return JSON.parse(input.serviceAccountKey).private_key_id?.slice(0, 8); } catch { return undefined; } })(),
      region,
    };
    const secret = { projectId: creds.projectId, serviceAccountKey: JSON.parse(input.serviceAccountKey) };

    // 4. Sign in + read the project (proves key, API enabled, basic permission)
    const provider = new GCPProvider(secret);
    let project: any;
    try {
      project = await provider.getProject();
      checks.push({ id: 'signin', label: 'Sign in to Google Cloud', status: 'pass', message: 'Google accepted the key and the Compute Engine API is on.' });
    } catch (error) {
      const f = toFriendlyError(error, 'gcp', creds.projectId);
      checks.push({
        id: 'signin', label: 'Sign in to Google Cloud', status: 'fail',
        // Unrecognised errors: show Google's own words so nothing is hidden.
        message: f.code === 'UNKNOWN' ? `Google said: ${f.raw}` : f.title,
        tip: f.fixes.join(' '), consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel,
      });
      return outcome(checks, undefined, metadata);
    }

    // 5. Global GPU quota
    const globalGpu = (project.quotas || []).find((q: any) => q.metric === 'GPUS_ALL_REGIONS');
    const globalLimit = Number(globalGpu?.limit) || 0;
    checks.push(globalLimit >= 1
      ? { id: 'gpu-global', label: 'GPU quota (all regions)', status: 'pass', message: `Up to ${globalLimit} GPU${globalLimit === 1 ? '' : 's'} at once.` }
      : {
          id: 'gpu-global', label: 'GPU quota (all regions)', status: 'warn',
          message: 'Your project is allowed 0 GPUs — launching will fail until this is raised.',
          tip: 'Request "GPUs (all regions)" = 1 on the Quotas page. Approval takes minutes to 2 days. Free-trial accounts must upgrade first.',
          consoleUrl: consoleUrl('iam-admin/quotas?metric=compute.googleapis.com%2Fgpus_all_regions', creds.projectId),
          consoleLabel: 'Request GPU quota',
        });

    // 6. Regional GPU quota
    try {
      const quotas = await provider.getRegionQuotas(region);
      const models = Array.from(new Set(GCP_SHAPES.map((s) => s.gpuQuotaMetric)));
      const found = models.map((m) => ({ metric: m, limit: quotas.find((q) => q.metric === m)?.limit || 0 }));
      const usable = found.filter((f) => f.limit >= 1);
      checks.push(usable.length
        ? { id: 'gpu-region', label: `GPU quota in ${region}`, status: 'pass', message: usable.map((u) => `${u.metric.replace(/_/g, ' ')}: ${u.limit}`).join(', ') }
        : {
            id: 'gpu-region', label: `GPU quota in ${region}`, status: 'warn',
            message: `No T4 or L4 GPU quota in ${region} yet.`,
            tip: `On the Quotas page, filter for "NVIDIA T4 GPUs" (cheaper) or "NVIDIA L4 GPUs", pick region ${region}, and request 1.`,
            consoleUrl: consoleUrl('iam-admin/quotas', creds.projectId),
            consoleLabel: 'Open Quotas',
          });
    } catch (error) {
      checks.push({ id: 'gpu-region', label: `GPU quota in ${region}`, status: 'warn', message: 'Couldn\'t read regional quotas.', tip: toFriendlyError(error, 'gcp', creds.projectId).title });
    }

    // 7. Default network
    try {
      const hasNetwork = await provider.hasDefaultNetwork();
      checks.push(hasNetwork
        ? { id: 'network', label: 'Network', status: 'pass', message: 'The "default" network exists.' }
        : {
            id: 'network', label: 'Network', status: 'warn',
            message: 'This project has no "default" network, which machines are created on.',
            tip: 'In Cloud Shell run: gcloud compute networks create default --subnet-mode=auto',
            consoleUrl: consoleUrl('networking/networks/list', creds.projectId), consoleLabel: 'Open VPC networks',
          });
    } catch (error) {
      checks.push({ id: 'network', label: 'Network', status: 'warn', message: 'Couldn\'t check the network.', tip: toFriendlyError(error, 'gcp', creds.projectId).title });
    }

    return outcome(checks, secret, metadata);
  },
};
