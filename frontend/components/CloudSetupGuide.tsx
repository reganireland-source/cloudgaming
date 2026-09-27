'use client';

/**
 * ============================================================================
 * frontend/components/CloudSetupGuide.tsx — STEP-BY-STEP CLOUD ACCOUNT SETUP
 * ============================================================================
 *
 * Detailed instructions for getting the credentials each cloud needs, shown
 * on the Config page (app/settings/page.tsx) under the credential form.
 *
 * DESIGN: THE CONTENT IS DATA
 * ---------------------------
 * Everything the guide says lives in the GUIDES object below — one entry per
 * cloud, each with: things to know first, numbered steps (a title plus a
 * longer explanation), which value goes into which form field, the GPU
 * quota request, and warnings. The JSX at the bottom just loops over that
 * data. To change the wording, edit GUIDES; you don't need to touch the layout.
 *
 * WHY THE GPU QUOTA SECTION MATTERS
 * ---------------------------------
 * New AWS, Azure and Google Cloud accounts are usually allowed ZERO GPU
 * machines until you ask for more. Launching fails with a quota error until
 * the request is approved, which can take hours or a few days — so do it first.
 *
 * NOTE ON LINKS: they point at each provider's web console. Consoles get
 * redesigned occasionally; if a deep link lands on the wrong page, the menu
 * path written in each step is the reliable route.
 * ============================================================================
 */

import { useEffect, useState } from 'react';

type ProviderKey = 'aws' | 'azure' | 'gcp' | 'oracle';

/** One numbered step: a short title, a fuller explanation, optional link. */
interface Step {
  title: string;
  detail: string;
  link?: { href: string; label: string };
}

/** Everything the guide shows for one cloud. */
interface Guide {
  label: string;
  accent: string;          // Tailwind text colour class for this cloud's headings
  status: string;          // how well the app supports this cloud today
  timeNeeded: string;
  beforeYouStart: string[];
  steps: Step[];
  fields: { field: string; value: string; example: string }[]; // form field -> what to paste
  quota: { summary: string; steps: string[] };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// THE CONTENT
// ---------------------------------------------------------------------------
const GUIDES: Record<ProviderKey, Guide> = {
  aws: {
    label: 'Amazon Web Services',
    accent: 'text-neon-cyan',
    status: 'Supported — the only cloud the app can launch machines on today.',
    timeNeeded: '~15 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'An AWS account with a payment method added. GPU machines are not in the free tier.',
      'Sign in as an administrator. Don\'t use the "root" login for the app — you\'ll create a separate, limited user below.',
      'Work in the Asia Pacific (Singapore) region, ap-southeast-1 — the region this project is set up for. Pick it in the region menu at the top right of the console; key pairs and quotas are per region.',
    ],
    steps: [
      {
        title: 'Create a dedicated IAM user for the app',
        detail:
          'IAM → Users → Create user. Name it something like "cloudgaming-hub". Leave "Provide user access to the AWS Management Console" unticked — this user is only for the app, not for logging in.',
        link: { href: 'https://console.aws.amazon.com/iam/home#/users', label: 'IAM → Users' },
      },
      {
        title: 'Give it only the permissions it needs',
        detail:
          'On the permissions screen choose "Attach policies directly" and tick: AmazonEC2FullAccess (launch/stop machines, disks, snapshots), AWSPriceListServiceFullAccess (look up hourly prices) and AWSBillingReadOnlyAccess (read actual spend). Click Next → Create user.',
      },
      {
        title: 'Turn on Cost Explorer (one-time)',
        detail:
          'Billing and Cost Management → Cost Explorer → Launch Cost Explorer. Needed for real cost figures; AWS takes up to 24 hours to prepare the data the first time.',
        link: { href: 'https://console.aws.amazon.com/cost-management/home#/cost-explorer', label: 'Cost Explorer' },
      },
      {
        title: 'Create an access key for the user',
        detail:
          'Open the user → "Security credentials" tab → Access keys → Create access key. Choose the use case "Application running outside AWS", click Next, add a description, then Create access key.',
      },
      {
        title: 'Copy both halves of the key immediately',
        detail:
          'You\'ll see an Access key ID (starts with AKIA…) and a Secret access key. The secret is shown ONCE — click "Download .csv file" as a backup. If you lose it, delete the key and make a new one.',
      },
      {
        title: 'Create the SSH key pair the app expects',
        detail:
          'EC2 → Network & Security → Key Pairs (in ap-southeast-1) → Create key pair. Name it exactly "cloudgaming-key" (the app uses this name), type RSA, format .pem. The .pem file downloads once — keep it safe; the backend needs it to finish setting up each machine.',
        link: { href: 'https://ap-southeast-1.console.aws.amazon.com/ec2/home?region=ap-southeast-1#KeyPairs:', label: 'EC2 → Key Pairs (Singapore)' },
      },
      {
        title: 'Create a security group (firewall) for streaming',
        detail:
          'EC2 → Security Groups → Create security group, e.g. "cloudgaming-sg". Inbound rules: TCP 22 (SSH, for automated setup); TCP 47984, 47989, 47990 and 48010; UDP 47998–48000, 48002 and 48010 (Sunshine/Moonlight streaming). Where possible set the source to your own IP rather than "Anywhere". Note: the backend currently has a placeholder security-group id (sg-0123456789abcdef0) in src/services/MachineService.ts — replace it with your new group\'s id.',
        link: { href: 'https://ap-southeast-1.console.aws.amazon.com/ec2/home?region=ap-southeast-1#SecurityGroups:', label: 'EC2 → Security Groups (Singapore)' },
      },
    ],
    fields: [
      { field: 'accessKeyId', value: 'Access key ID from step 5', example: 'AKIAIOSFODNN7EXAMPLE' },
      { field: 'secretAccessKey', value: 'Secret access key from step 5', example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY…' },
      { field: 'region', value: 'The region code', example: 'ap-southeast-1' },
    ],
    quota: {
      summary:
        'AWS measures GPU quota in vCPUs (virtual CPU cores), not machines. A g4dn.xlarge uses 4 vCPUs. The app launches SPOT machines (cheaper, can be interrupted), so the spot quota is the one that matters most.',
      steps: [
        'Service Quotas → AWS services → Amazon Elastic Compute Cloud (Amazon EC2), with the region set to Singapore.',
        'Search "All G and VT Spot Instance Requests" → Request increase at account level → enter 8 (room for two g4dn.xlarge).',
        'Also search "Running On-Demand G and VT instances" and request 8 as well, as a fallback.',
        'Approval is often automatic for small numbers but can take a day or two for new accounts. You\'ll get an email.',
      ],
    },
    warnings: [
      'Never paste your root account keys here — only the dedicated user\'s.',
      'A running g4dn.xlarge costs roughly US$0.50+/hour plus data transfer. Stop machines you\'re not using.',
    ],
  },

  azure: {
    label: 'Microsoft Azure',
    accent: 'text-neon-magenta',
    status: 'Credentials can be entered, but launching Azure machines isn\'t built yet.',
    timeNeeded: '~20 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'A Pay-As-You-Go (or other paid) subscription. Free-trial subscriptions can\'t get GPU quota.',
      'Owner or User Access Administrator rights on the subscription — you need them to grant the app access in step 6.',
      'Suggested region: Southeast Asia (Singapore).',
    ],
    steps: [
      {
        title: 'Register an application (the app\'s identity)',
        detail:
          'Microsoft Entra ID → App registrations → New registration. Name: "cloudgaming-hub". Supported account types: "Accounts in this organizational directory only". Leave Redirect URI empty → Register.',
        link: { href: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', label: 'App registrations' },
      },
      {
        title: 'Copy the two IDs from the Overview page',
        detail:
          'On the new app\'s Overview, copy "Application (client) ID" (→ clientId) and "Directory (tenant) ID" (→ tenantId). Both look like 1a2b3c4d-… .',
      },
      {
        title: 'Create a client secret (the app\'s password)',
        detail:
          'Certificates & secrets → Client secrets → New client secret. Description "cloudgaming-hub", expiry e.g. 12 months → Add. Copy the "Value" column straight away — NOT the "Secret ID" column. The value is only shown once. Put a reminder in your calendar to renew it before it expires.',
      },
      {
        title: 'Copy your Subscription ID',
        detail: 'Subscriptions → click your subscription → copy "Subscription ID".',
        link: { href: 'https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade', label: 'Subscriptions' },
      },
      {
        title: 'Create a resource group to hold the machines',
        detail:
          'Resource groups → Create. Subscription: yours; name "cloudgaming-rg"; region Southeast Asia → Review + create → Create. Everything the app creates will live in here, which keeps it tidy and easy to delete.',
        link: { href: 'https://portal.azure.com/#browse/resourcegroups', label: 'Resource groups' },
      },
      {
        title: 'Grant the app "Contributor" on that resource group',
        detail:
          'Open cloudgaming-rg → Access control (IAM) → Add → Add role assignment. On the "Privileged administrator roles" tab choose Contributor → Next. "Assign access to": User, group, or service principal → Select members → search "cloudgaming-hub" → Select → Review + assign. Granting it on the resource group (not the whole subscription) limits what the app can touch.',
      },
    ],
    fields: [
      { field: 'subscriptionId', value: 'Subscription ID (step 4)', example: '00000000-0000-0000-0000-000000000000' },
      { field: 'clientId', value: 'Application (client) ID (step 2)', example: '1a2b3c4d-…' },
      { field: 'clientSecret', value: 'Client secret VALUE (step 3)', example: 'abc8Q~…' },
      { field: 'tenantId', value: 'Directory (tenant) ID (step 2)', example: '5e6f7a8b-…' },
      { field: 'resourceGroup', value: 'Resource group name (step 5)', example: 'cloudgaming-rg' },
    ],
    quota: {
      summary:
        'Azure grants GPU capacity per VM "family", in vCPUs, per region. New subscriptions usually have 0 for GPU families.',
      steps: [
        'Search the portal for "Quotas" → Compute → filter region "Southeast Asia".',
        'Find a GPU family such as "Standard NVADSA10v5 Family vCPUs" (NVIDIA A10) or "Standard NCASv3_T4 Family vCPUs" (NVIDIA T4).',
        'Click the pencil / "New quota request" and ask for at least 6–8 vCPUs.',
        'Note: the older NV-series (Standard_NV6) used in this app\'s price tables has been retired by Microsoft — the A10 or T4 families are the current equivalents.',
      ],
    },
    warnings: [
      'The client secret expires — when it does, create a new one and update it here.',
    ],
  },

  gcp: {
    label: 'Google Cloud Platform',
    accent: 'text-neon-lime',
    status: 'Credentials can be entered, but launching Google Cloud machines isn\'t built yet.',
    timeNeeded: '~15 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'A project with billing enabled. Free-trial accounts cannot use GPUs — click "Activate full account" first.',
      'Suggested region: asia-southeast1 (Singapore).',
    ],
    steps: [
      {
        title: 'Pick (or create) a project and note its Project ID',
        detail:
          'Use the project picker at the top of the console. Copy the Project ID (e.g. "my-gaming-412305") — not the display name; they are often different.',
      },
      {
        title: 'Enable the Compute Engine API',
        detail:
          'APIs & Services → Library → search "Compute Engine API" → Enable. Takes a minute or two the first time.',
        link: { href: 'https://console.cloud.google.com/apis/library/compute.googleapis.com', label: 'Compute Engine API' },
      },
      {
        title: 'Create a service account (the app\'s identity)',
        detail:
          'IAM & Admin → Service Accounts → Create service account. Name "cloudgaming-hub" → Create and continue.',
        link: { href: 'https://console.cloud.google.com/iam-admin/serviceaccounts', label: 'Service Accounts' },
      },
      {
        title: 'Give it the roles it needs',
        detail:
          'Under "Grant this service account access to project", add: Compute Admin (create/stop VMs, disks, snapshots) and Service Account User (lets it start VMs that run as a service account) → Continue → Done.',
      },
      {
        title: 'Create a JSON key',
        detail:
          'Click the new service account → Keys tab → Add key → Create new key → JSON → Create. A .json file downloads. If you see "Key creation is disabled", your organisation blocks it with the policy iam.disableServiceAccountKeyCreation — an organisation admin has to allow it for this project.',
      },
      {
        title: 'Paste the WHOLE file',
        detail:
          'Open the .json file in a text editor and copy everything, from the first { to the last } — including the long "private_key" line. Partial copies are the most common cause of "invalid key" errors.',
      },
    ],
    fields: [
      { field: 'projectId', value: 'Project ID (step 1)', example: 'my-gaming-412305' },
      { field: 'serviceAccountKey', value: 'Entire contents of the JSON key file (step 6)', example: '{ "type": "service_account", "project_id": … }' },
    ],
    quota: {
      summary:
        'Google has TWO GPU limits and both must be above zero: a global "all regions" count and a per-region count for the specific GPU model.',
      steps: [
        'IAM & Admin → Quotas & System Limits.',
        'Filter "GPUs (all regions)" → select it → Edit → request at least 1.',
        'Filter e.g. "NVIDIA T4 GPUs" or "NVIDIA L4 GPUs" for region asia-southeast1 → request at least 1.',
        'Approval usually takes from a few minutes to 2 business days.',
      ],
    },
    warnings: [
      'The JSON key file is a password — don\'t commit it to git or share it. Delete keys you no longer use (Keys tab).',
    ],
  },

  oracle: {
    label: 'Oracle Cloud (OCI)',
    accent: 'text-neon-magenta',
    status: 'Credentials can be entered, but launching Oracle machines isn\'t built yet.',
    timeNeeded: '~20 minutes, plus waiting for a GPU limit increase',
    beforeYouStart: [
      'An upgraded ("Pay As You Go") account. Always Free / trial accounts don\'t include GPU shapes.',
      'Oracle calls every resource\'s ID an OCID — a long string like ocid1.user.oc1..aaaa… . You\'ll copy several.',
      'Suggested region: Singapore (ap-singapore-1).',
      'Oracle\'s big advantage: the first 10 TB of outbound data each month is free (in every region). Streaming is mostly outbound data, so this can save a lot.',
    ],
    steps: [
      {
        title: 'Copy your User OCID',
        detail:
          'Profile icon (top right) → My profile → copy the OCID shown (starts with ocid1.user.). Use the OCID, not your username or email.',
        link: { href: 'https://cloud.oracle.com/identity/domains/my-profile', label: 'My profile' },
      },
      {
        title: 'Copy your Tenancy OCID',
        detail:
          'Profile icon → "Tenancy: <your name>" → copy the OCID (starts with ocid1.tenancy.).',
      },
      {
        title: 'Create a compartment for the app',
        detail:
          'Identity & Security → Compartments → Create compartment, name "cloudgaming" → Create. Open it and copy its OCID (starts with ocid1.compartment.). (You can use the root compartment instead — its OCID is the same as the tenancy OCID — but a separate one keeps things tidy.)',
        link: { href: 'https://cloud.oracle.com/identity/compartments', label: 'Compartments' },
      },
      {
        title: 'Generate an API signing key',
        detail:
          'My profile → Resources (left) → API keys → Add API key → "Generate API key pair" → Download private key (a .pem file) → Add.',
      },
      {
        title: 'Copy the fingerprint',
        detail:
          'After clicking Add, a "Configuration file preview" appears. Copy the fingerprint line — it looks like 12:34:56:ab:cd:… (16 pairs separated by colons).',
      },
      {
        title: 'Paste the private key',
        detail:
          'Open the downloaded .pem file in a text editor and copy all of it, including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.',
      },
      {
        title: 'Permissions (only if you are not a tenancy administrator)',
        detail:
          'An admin must add a policy for your group, e.g.: "Allow group CloudGaming to manage instance-family in compartment cloudgaming", plus the same for "volume-family", and "use virtual-network-family".',
      },
    ],
    fields: [
      { field: 'compartmentId', value: 'Compartment OCID (step 3)', example: 'ocid1.compartment.oc1..aaaa…' },
      { field: 'userId', value: 'User OCID (step 1)', example: 'ocid1.user.oc1..aaaa…' },
      { field: 'tenancy', value: 'Tenancy OCID (step 2)', example: 'ocid1.tenancy.oc1..aaaa…' },
      { field: 'fingerprint', value: 'API key fingerprint (step 5)', example: '12:34:56:78:9a:bc:de:f0:…' },
      { field: 'privateKey', value: 'Full contents of the .pem file (step 6)', example: '-----BEGIN PRIVATE KEY-----…' },
    ],
    quota: {
      summary: 'Oracle calls quotas "service limits". GPU shapes start at 0 for most accounts.',
      steps: [
        'Governance & Administration → Limits, Quotas and Usage.',
        'Service: Compute; scope: the Singapore availability domain; find a GPU shape such as "GPU A10 count" (VM.GPU.A10.1).',
        'Click "Request a service limit update" and ask for 1.',
      ],
    },
    warnings: [
      'The .pem private key is a password — keep the file safe and don\'t share it.',
    ],
  },
};

const ORDER: ProviderKey[] = ['aws', 'azure', 'gcp', 'oracle'];

/**
 * @param selected optional: which cloud to show. The Config page passes the
 *                 provider you clicked, so the guide follows your choice.
 */
export default function CloudSetupGuide({ selected }: { selected?: ProviderKey | null }) {
  // Which tab is showing. Starts on the page's selection, or AWS.
  const [active, setActive] = useState<ProviderKey>(selected || 'aws');

  // When the parent's selection changes, follow it. (useEffect with
  // [selected] re-runs whenever `selected` changes.)
  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);

  const guide = GUIDES[active];

  return (
    <div className="neon-card rounded-lg border border-neon-cyan/30 p-6 mb-8">
      <h3 className="text-sm tracking-label font-bold neon-text mb-2 font-mono">[ CREDENTIAL_SETUP_GUIDE ]</h3>
      <p className="text-xs text-slate-400 mb-6 max-w-3xl">
        Step-by-step instructions for creating a limited-access login for the app on each cloud. Do the
        GPU quota request early — it's the step most likely to hold you up.
      </p>

      {/* ---- Tabs: one per cloud ---- */}
      <div className="flex flex-wrap gap-2 mb-6" role="tablist">
        {ORDER.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={active === key}
            onClick={() => setActive(key)}
            className={`px-3 py-1.5 rounded text-[0.72rem] uppercase tracking-label border transition-colors ${
              active === key
                ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.08]'
                : 'border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
            }`}
          >
            {GUIDES[key].label}
          </button>
        ))}
      </div>

      {/* ---- Status + time ---- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6 text-xs">
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <p className="label mb-1">App support</p>
          <p className="text-slate-300">{guide.status}</p>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <p className="label mb-1">Time needed</p>
          <p className="text-slate-300">{guide.timeNeeded}</p>
        </div>
      </div>

      {/* ---- Before you start ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-2 ${guide.accent}`}>Before you start</h4>
        <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-5">
          {guide.beforeYouStart.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </section>

      {/* ---- Numbered steps ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-3 ${guide.accent}`}>Steps</h4>
        <ol className="space-y-3">
          {guide.steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              {/* The step number badge. i starts at 0, so show i + 1. */}
              <span className="flex-shrink-0 w-6 h-6 rounded-full border border-neon-cyan/40 text-neon-cyan text-[0.7rem] flex items-center justify-center">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[0.8rem] text-slate-100 font-medium">{step.title}</p>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{step.detail}</p>
                {step.link && (
                  // target="_blank" opens a new tab; rel="noopener noreferrer"
                  // stops the opened page from controlling this one (a
                  // standard safety measure for external links).
                  <a
                    href={step.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-1 text-[0.72rem] text-neon-cyan hover:underline"
                  >
                    Open {step.link.label} ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ---- Which value goes in which form field ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-2 ${guide.accent}`}>What to paste into the form above</h4>
        {/* overflow-x-auto lets the table scroll sideways on narrow phones */}
        <div className="overflow-x-auto rounded border border-white/10">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="px-3 py-2 font-medium">Form field</th>
                <th className="px-3 py-2 font-medium">What it is</th>
                <th className="px-3 py-2 font-medium">Looks like</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {guide.fields.map((f) => (
                <tr key={f.field}>
                  <td className="px-3 py-2 text-neon-cyan whitespace-nowrap">{f.field.toUpperCase()}</td>
                  <td className="px-3 py-2 text-slate-300">{f.value}</td>
                  <td className="px-3 py-2 text-slate-500 break-all">{f.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- GPU quota ---- */}
      <section className="mb-6 rounded border border-neon-amber/30 bg-neon-amber/[0.05] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-1 text-neon-amber">Request GPU quota (do this first)</h4>
        <p className="text-xs text-slate-300 mb-2 leading-relaxed">{guide.quota.summary}</p>
        <ol className="space-y-1 text-xs text-slate-300 list-decimal pl-5">
          {guide.quota.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </section>

      {/* ---- Warnings ---- */}
      <section className="rounded border border-neon-pink/30 bg-neon-pink/[0.05] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-1 text-neon-pink">Keep in mind</h4>
        <ul className="space-y-1 text-xs text-slate-300 list-disc pl-5">
          {guide.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
