/**
 * ============================================================================
 * src/providers/gcp/errors.ts — TURN GOOGLE CLOUD ERRORS INTO PLAIN ENGLISH
 * ============================================================================
 *
 * Google Cloud's errors are precise but cryptic, e.g.
 *   "Quota 'GPUS_ALL_REGIONS' exceeded. Limit: 0.0 globally."
 *   "ZONE_RESOURCE_POOL_EXHAUSTED"
 *   "Compute Engine API has not been used in project 123 before or it is disabled"
 *
 * This file recognises the common ones and converts each into a
 * FriendlyError: a short title, what it means, the exact steps to fix it,
 * and (where useful) a direct link to the right Google Cloud console page.
 * The frontend shows this as an error card, so most problems can be fixed
 * without hunting through the console.
 *
 * Anything we don't recognise still becomes a FriendlyError, with the raw
 * message kept in `raw` so nothing is hidden.
 *
 * The shared machinery (FriendlyError, toFriendlyError) is in
 * src/providers/errors.ts; this file holds only Google's rules.
 *
 * ADDING A NEW CASE: add an entry to GCP_RULES below. Rules are checked top to
 * bottom and the first match wins, so put specific rules before general ones.
 * ============================================================================
 */

import { FriendlyError, FriendlyCloudError, Rule, errorText, toFriendlyError } from '../errors';
// Re-exported so existing imports from './gcp/errors' keep working.
export { FriendlyError, FriendlyCloudError, toFriendlyError };

/**
 * A Google Cloud console link, opened on the user's project when we know it.
 * Set per call by the shared toFriendlyError (each user has their own project).
 */
let currentProject: string | undefined;
export function setGcpProjectContext(projectId: string | undefined): void {
  currentProject = projectId;
}
function consoleLink(path: string): string {
  const project = currentProject;
  const separator = path.includes('?') ? '&' : '?';
  return `https://console.cloud.google.com/${path}${project ? `${separator}project=${project}` : ''}`;
}

export const GCP_RULES: Rule[] = [
  // ---- Credentials ------------------------------------------------------
  {
    test: /invalid_grant|invalid jwt|jwt signature|account not found|private key|DECODER routines|PEM|invalid authentication credentials|UNAUTHENTICATED|Expected OAuth 2 access token/i,
    build: () => ({
      code: 'GCP_KEY_INVALID',
      title: 'Google rejected the service account key',
      explanation:
        'The JSON key the backend is using is damaged, incomplete, or has been deleted in Google Cloud.',
      fixes: [
        'In Google Cloud, open IAM & Admin → Service Accounts → cloudgaming-hub → Keys, and check the key still exists.',
        'If it doesn\'t (or you\'re unsure), create a new JSON key there.',
        'On the Config page here, remove the Google Cloud credentials and add them again with the ENTIRE new file.',
      ],
      consoleUrl: consoleLink('iam-admin/serviceaccounts'),
      consoleLabel: 'Open Service Accounts',
    }),
  },

  // ---- API switched off / billing ---------------------------------------
  {
    test: /Compute Engine API has not been used|compute\.googleapis\.com.*(disabled|not been used)|SERVICE_DISABLED|accessNotConfigured/i,
    build: () => ({
      code: 'GCP_API_DISABLED',
      title: 'The Compute Engine API is switched off for this project',
      explanation: 'Google Cloud needs its Compute Engine API enabled before anything can create virtual machines.',
      fixes: [
        'Click the button below and press "Enable".',
        'Wait a minute or two, then try again here.',
        'If the Enable button complains about billing, link a billing account to the project first.',
      ],
      consoleUrl: consoleLink('apis/library/compute.googleapis.com'),
      consoleLabel: 'Enable Compute Engine API',
    }),
  },
  {
    test: /billing (account|is) (disabled|not enabled|closed)|BILLING_DISABLED|requires billing/i,
    build: () => ({
      code: 'GCP_BILLING',
      title: 'Billing isn\'t active on this project',
      explanation: 'Google Cloud won\'t create machines until the project is linked to an active billing account.',
      fixes: [
        'Open Billing in the Google Cloud console and link the project to a billing account.',
        'If you\'re on the free trial, click "Activate full account" — trial accounts can\'t use GPUs at all.',
      ],
      consoleUrl: consoleLink('billing/linkedaccount'),
      consoleLabel: 'Open Billing',
    }),
  },

  // ---- Quotas -----------------------------------------------------------
  {
    test: /Quota '?(GPUS_ALL_REGIONS)'? exceeded/i,
    build: () => ({
      code: 'GPU_QUOTA_GLOBAL',
      title: 'Your project isn\'t allowed any GPUs yet',
      explanation:
        'New Google Cloud projects start with a GPU limit of 0. There are two limits and both must be at least 1: a global "GPUs (all regions)" limit, and a per-region limit for the GPU model. This error is the global one.',
      fixes: [
        'Click the button below (IAM & Admin → Quotas & System Limits).',
        'Filter for "GPUs (all regions)", tick it, click "Edit", request 1 (or more) and submit with a short reason like "cloud gaming".',
        'Also request the per-region GPU quota (e.g. "NVIDIA T4 GPUs" or "NVIDIA L4 GPUs" in your region) — see the other quota error if it appears.',
        'Approval usually takes from a few minutes to 2 business days. You\'ll get an email.',
      ],
      consoleUrl: consoleLink('iam-admin/quotas?metric=compute.googleapis.com%2Fgpus_all_regions'),
      consoleLabel: 'Request GPU quota',
    }),
  },
  {
    // G4 (RTX PRO 6000) on-demand: the per-family quota.
    test: /Quota '?GPUS_PER_GPU_FAMILY'? exceeded.*?(?:region:?\s*([a-z0-9-]+))?/i,
    build: (_raw, m) => ({
      code: 'GPU_QUOTA_REGION',
      title: `No RTX PRO 6000 quota${m[1] ? ` in ${m[1]}` : ''}`,
      explanation: 'G4 machines use the "GPUs per GPU family" quota (gpu_family NVIDIA_RTX_PRO_6000), per region. Spot G4 uses "Preemptible NVIDIA RTX PRO 6000 GPUs" instead.',
      fixes: [
        'Click the button below, filter "GPUs per GPU family", pick the row for NVIDIA_RTX_PRO_6000 in ' + (m[1] || 'your region') + ', click "Edit", request 1 and submit.',
        'The Regions page has a ready-to-paste gcloud command for it.',
      ],
      consoleUrl: consoleLink('iam-admin/quotas?metric=compute.googleapis.com%2Fgpus_per_gpu_family'),
      consoleLabel: 'Open Quotas',
    }),
  },
  {
    test: /Quota '?((?:PREEMPTIBLE_)?NVIDIA_[A-Z0-9_]+_GPUS)'? exceeded.*?(?:region:?\s*([a-z0-9-]+))?/i,
    build: (_raw, m) => ({
      code: 'GPU_QUOTA_REGION',
      title: `No ${m[1].replace(/_/g, ' ').replace(/PREEMPTIBLE /i, 'spot ')} quota${m[2] ? ` in ${m[2]}` : ''}`,
      explanation:
        'Your project has no (or not enough) quota for this GPU model in this region. Quotas are per region and per GPU model' +
        (/PREEMPTIBLE/i.test(m[1]) ? ', and spot machines use a separate "Preemptible" quota.' : '.'),
      fixes: [
        'Click the button below and filter by the metric name shown in the title (e.g. "NVIDIA T4 GPUs").',
        `Pick the row for ${m[2] || 'your region'}, click "Edit", request 1 and submit.`,
        'Or try a different region or GPU type here — you may already have quota elsewhere.',
      ],
      consoleUrl: consoleLink('iam-admin/quotas'),
      consoleLabel: 'Open Quotas',
    }),
  },
  {
    test: /Quota '?([A-Z_]+)'? exceeded/i,
    build: (_raw, m) => ({
      code: 'QUOTA',
      title: `Google Cloud quota "${m[1]}" is used up`,
      explanation: 'This project has hit one of its resource limits (for example CPUs, disks or IP addresses in the region).',
      fixes: [
        'Delete machines or disks you no longer need, or',
        `Request more "${m[1]}" quota on the Quotas page (button below).`,
      ],
      consoleUrl: consoleLink('iam-admin/quotas'),
      consoleLabel: 'Open Quotas',
    }),
  },

  // ---- Capacity ---------------------------------------------------------
  {
    test: /ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources|resource pool exhausted|STOCKOUT/i,
    build: () => ({
      code: 'ZONE_EXHAUSTED',
      title: 'Google is out of these GPUs in this area right now',
      explanation:
        'This isn\'t a problem with your account — Google temporarily has no spare machines of this type in the zones we tried. It usually clears within minutes to hours.',
      fixes: [
        'Try again in a few minutes.',
        'Or pick a different GPU type (T4 ↔ L4) or a different region.',
        'Spot machines are the first to run out; switching spot off can help.',
      ],
    }),
  },

  // ---- Permissions ------------------------------------------------------
  {
    test: /Required '(compute\.[a-zA-Z.]+|iam\.serviceAccounts\.actAs)' permission|PERMISSION_DENIED|does not have (?:the )?permission|403/i,
    build: (raw) => {
      const perm = raw.match(/'((?:compute|iam)\.[a-zA-Z.]+)'/)?.[1];
      return {
        code: 'GCP_PERMISSION',
        title: perm ? `The service account is missing the "${perm}" permission` : 'The service account isn\'t allowed to do that',
        explanation:
          'The key works, but the service account behind it doesn\'t have the right roles on this project.',
        fixes: [
          'Open IAM & Admin → IAM (button below) and find the cloudgaming-hub service account.',
          'Click the pencil icon and make sure it has BOTH roles: "Compute Admin" and "Service Account User".',
          'Save, wait a minute, then try again.',
          'Also check the project ID you saved on the Config page matches the project the service account belongs to.',
        ],
        consoleUrl: consoleLink('iam-admin/iam'),
        consoleLabel: 'Open IAM',
      };
    },
  },

  // ---- Organisation policies -------------------------------------------
  {
    test: /constraints\/compute\.vmExternalIpAccess/i,
    build: () => ({
      code: 'ORG_POLICY_EXTERNAL_IP',
      title: 'Your organisation blocks machines with public IP addresses',
      explanation:
        'Streaming needs the machine to have a public IP, but the organisation policy "compute.vmExternalIpAccess" forbids it.',
      fixes: [
        'In Cloud Shell, run: gcloud resource-manager org-policies disable-enforce compute.vmExternalIpAccess --project=' + (currentProject || 'YOUR_PROJECT_ID'),
        'If that says the constraint is a list policy, use the Organisation Policies page (button below) → "Define allowed external IPs for VM instances" → Override → "Allow all".',
      ],
      consoleUrl: consoleLink('iam-admin/orgpolicies/compute-vmExternalIpAccess'),
      consoleLabel: 'Open the policy',
    }),
  },
  {
    test: /constraints\/([a-zA-Z.]+)/,
    build: (_raw, m) => ({
      code: 'ORG_POLICY',
      title: `An organisation policy blocks this (${m[1]})`,
      explanation: 'Your Google Cloud organisation has a rule that forbids this action on this project.',
      fixes: [
        `In IAM & Admin → Organisation Policies, find "${m[1]}" and override it for this project.`,
        'You need the "Organisation Policy Administrator" role on the organisation to change it.',
      ],
      consoleUrl: consoleLink('iam-admin/orgpolicies'),
      consoleLabel: 'Open Organisation Policies',
    }),
  },

  // ---- Missing things ---------------------------------------------------
  {
    test: /networks\/default.*(not found|was not found)|The resource '.*networks\/default' was not found/i,
    build: () => ({
      code: 'NO_DEFAULT_NETWORK',
      title: 'This project has no "default" network',
      explanation: 'Machines are created on the project\'s "default" VPC network, and it doesn\'t exist here.',
      fixes: [
        'In Cloud Shell run: gcloud compute networks create default --subnet-mode=auto',
        'Then try again.',
      ],
      consoleUrl: consoleLink('networking/networks/list'),
      consoleLabel: 'Open VPC networks',
    }),
  },
  {
    test: /was not found|NOT_FOUND|404/i,
    build: () => ({
      code: 'NOT_FOUND',
      title: 'Google Cloud couldn\'t find that resource',
      explanation:
        'The machine, disk or snapshot no longer exists at Google Cloud — it may have been deleted in the console.',
      fixes: ['Press "Sync" to refresh the machine\'s real state.', 'If it\'s gone, delete it here to clean up the record.'],
      consoleUrl: consoleLink('compute/instances'),
      consoleLabel: 'Open VM instances',
    }),
  },

  // ---- Network trouble reaching Google ----------------------------------
  {
    test: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|DEADLINE_EXCEEDED|timeout/i,
    build: () => ({
      code: 'NETWORK',
      title: 'Couldn\'t reach Google Cloud',
      explanation: 'The backend didn\'t get an answer from Google in time. This is usually temporary.',
      fixes: ['Try again in a minute.', 'If it keeps happening, check the GCP status light and Google\'s status page (status.cloud.google.com).'],
    }),
  },
];

/**
 * Is this the kind of error where trying ANOTHER ZONE might work?
 * (Sold-out zones, or a GPU/machine type that simply isn't offered in that
 * zone.) Quota, permission and credential errors are not — they'd fail the
 * same way everywhere, so we stop immediately instead.
 */
export function isZoneSpecificError(error: unknown): boolean {
  const raw = errorText(error);
  if (/Quota|PERMISSION|permission|invalid_grant|disabled|billing|constraints\//i.test(raw)) return false;
  return /ZONE_RESOURCE_POOL_EXHAUSTED|STOCKOUT|does not have enough resources|acceleratorTypes\/.*(not found|was not found|does not exist)|machineTypes\/.*(not found|was not found|does not exist)|not available in zone|Invalid value for field 'resource.(guestAccelerators|machineType)'|UNSUPPORTED_OPERATION/i.test(raw);
}
