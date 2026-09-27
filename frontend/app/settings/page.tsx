'use client';
// ↑ Client component: the page keeps form state and reacts to clicks.

/**
 * ============================================================================
 * frontend/app/settings/page.tsx — THE "CONFIG" PAGE (/settings)
 * ============================================================================
 *
 * Three sections, top to bottom:
 *   1. YOUR_CLOUD_KEYS — add, re-check or remove the limited-access keys for
 *      each cloud (components/CredentialManager.tsx). Needs you signed in.
 *      Keys are checked live against the cloud, then ENCRYPTED on the
 *      backend before being stored, and never shown again.
 *   2. CREDENTIAL_SETUP_GUIDE — step-by-step instructions for creating those
 *      keys in each cloud's console (components/CloudSetupGuide.tsx). It
 *      follows whichever cloud's form you open.
 *   3. TROUBLESHOOTING — common error messages and what they mean.
 * ============================================================================
 */

import { useState } from 'react';
import CloudSetupGuide from '@/components/CloudSetupGuide';
import CredentialManager from '@/components/CredentialManager';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

type ProviderKey = 'aws' | 'azure' | 'gcp' | 'oracle';

// Troubleshooting entries, as data: `cloud` is the small tag, `title` the
// error you'd see, `fixes` the things to check, in the order to check them.
const TROUBLESHOOTING: { cloud: string; title: string; fixes: string[] }[] = [
  {
    cloud: 'AWS',
    title: 'InvalidClientTokenId / SignatureDoesNotMatch',
    fixes: [
      'The Access Key ID or Secret Access Key was copied wrongly — a missing character or an extra space is enough.',
      'The key may have been deleted or made inactive: IAM → Users → your user → Security credentials.',
      'If in doubt, delete the key and create a new one. The secret is only shown once, when it is created.',
    ],
  },
  {
    cloud: 'AWS',
    title: 'UnauthorizedOperation / AccessDenied',
    fixes: [
      'The keys work but the IAM user lacks permission. Check the policies attached to the user (see the setup guide above).',
      'Cost figures need Cost Explorer turned on once, in Billing → Cost Explorer. It takes up to 24 hours to start.',
    ],
  },
  {
    cloud: 'AWS',
    title: 'VcpuLimitExceeded / "You have requested more vCPU capacity than your current vCPU limit"',
    fixes: [
      'New accounts have a GPU instance limit of 0. Request more under Service Quotas → Amazon EC2 → "Running On-Demand G and VT instances".',
      'The limit is counted in vCPUs, not machines: a g4dn.xlarge needs 4, so ask for at least 8.',
      'Quotas are per region. Request it in the same region you set in the app (for example ap-southeast-1).',
    ],
  },
  {
    cloud: 'Azure',
    title: 'AuthorizationFailed / "does not have authorization to perform action"',
    fixes: [
      'The app registration has no role on the subscription. Go to Subscriptions → your subscription → Access control (IAM) → Add role assignment → Contributor → select the app.',
      'Role assignments can take a few minutes to take effect.',
    ],
  },
  {
    cloud: 'Azure',
    title: 'AADSTS7000215: Invalid client secret provided',
    fixes: [
      'You pasted the secret\'s ID instead of its Value. Only the Value column works, and it is only shown right after creating the secret.',
      'Client secrets expire (6–24 months). Create a new one under Certificates & secrets.',
    ],
  },
  {
    cloud: 'Azure',
    title: 'OperationNotAllowed / quota exceeded for NV-series',
    fixes: [
      'Request GPU quota under Subscriptions → Usage + quotas, filtered to your region and the NVadsA10 v5 family.',
      'Free and trial subscriptions cannot get GPU quota — upgrade to pay-as-you-go first.',
    ],
  },
  {
    cloud: 'GCP',
    title: 'Invalid JWT / "invalid_grant" / key could not be parsed',
    fixes: [
      'Paste the ENTIRE JSON key file, from the first { to the last }. The private_key inside contains \\n sequences — keep them exactly as they are.',
      'The key may have been deleted. Check IAM & Admin → Service Accounts → the account → Keys.',
    ],
  },
  {
    cloud: 'GCP',
    title: 'Service account key creation is disabled (iam.disableServiceAccountKeyCreation)',
    fixes: [
      'Your project sits inside a Google Cloud "organisation". One is created automatically if you sign in with a Google Workspace or custom-domain email, and new organisations turn this policy on by default. Check with the project picker: an organisation name above the project means you have one.',
      'Give yourself permission to change policies: switch the project picker to the ORGANISATION (not the project) → IAM & Admin → IAM → Grant access → your email → role "Organisation Policy Administrator" → Save. Being the organisation\'s owner isn\'t enough on its own; this role must be added explicitly.',
      'Switch the picker back to your PROJECT → IAM & Admin → Organisation Policies → search "Disable service account key creation" → Manage policy → "Override parent\'s policy" → Add a rule → Enforcement: Off → Set policy. This only affects this project; the rest of the organisation stays protected.',
      'If the list also shows a "managed" version of the same constraint (iam.managed.disableServiceAccountKeyCreation), turn that one off the same way.',
      'Wait 1–2 minutes, then create the JSON key again. Or, in Cloud Shell: gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=YOUR_PROJECT_ID',
    ],
  },
  {
    cloud: 'GCP',
    title: 'Permission "compute.instances.create" denied / 403 Forbidden',
    fixes: [
      'The service account needs the Compute Admin and Service Account User roles. Add them under IAM & Admin → IAM → Grant access.',
      'Check that the Project ID in the app matches the project_id inside the JSON key.',
    ],
  },
  {
    cloud: 'GCP',
    title: 'Compute Engine API has not been used in project … or it is disabled',
    fixes: [
      'Enable it under APIs & Services → Library → Compute Engine API → Enable, then wait a minute or two and retry.',
      'Billing must be linked to the project, or the API cannot be turned on.',
    ],
  },
  {
    cloud: 'GCP',
    title: 'Quota \'GPUS_ALL_REGIONS\' exceeded. Limit: 0.0',
    fixes: [
      'Request quota under IAM & Admin → Quotas: raise "GPUs (all regions)" to at least 1, AND the per-region GPU quota (for example NVIDIA T4 or L4 GPUs in asia-southeast1).',
      'Free-trial accounts cannot get GPU quota. Upgrade to a full billing account first.',
      'Approval usually takes minutes to a couple of days.',
    ],
  },
  {
    cloud: 'Oracle',
    title: 'NotAuthenticated / 401',
    fixes: [
      'The fingerprint must match the uploaded public key exactly (it looks like aa:bb:cc:…).',
      'Use OCIDs, not names: the user OCID starts with ocid1.user, the tenancy with ocid1.tenancy.',
      'The private key must be pasted whole, including the -----BEGIN … KEY----- and -----END … KEY----- lines.',
    ],
  },
  {
    cloud: 'Oracle',
    title: 'NotAuthorizedOrNotFound / 404',
    fixes: [
      'Oracle reports "no permission" and "not found" as the same error. Check the user\'s group has a policy like: Allow group CloudGaming to manage instance-family in compartment <name>.',
      'Check the compartment OCID (ocid1.compartment…) is the one the policy names.',
    ],
  },
  {
    cloud: 'Any',
    title: 'Worked before, fails now',
    fixes: [
      'Credentials can expire or be rotated by an admin. Create new ones and use "Replace keys" above; "Re-check now" shows what changed.',
      'Check the status lights at the top of the page: a red cloud light means the backend could not reach that cloud.',
    ],
  },
];

export default function SettingsPage() {
  // Which cloud's key form is open — the setup guide below follows it.
  const [guideFor, setGuideFor] = useState<ProviderKey | null>(null);
  // Who's signed in (components/AuthProvider.tsx). The guide below is public;
  // only managing keys needs an account.
  const { user, loading } = useAuth();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold neon-text mb-2 font-mono">[ CONFIGURATION ]</h1>
        <p className="text-sm text-slate-400 max-w-3xl">
          Connect Gints Global Gaming Hubjob to <strong>your own</strong> cloud accounts. Machines are created in your account and billed to you by the
          cloud; this app only stores a limited-access key, encrypted, so it can start and stop them for you.
        </p>
        <p className="text-sm text-slate-400 mt-2">
          First time? Run the <Link href="/preflight" className="text-neon-cyan hover:underline">pre-flight check</Link> — it spots setup mistakes before you launch.
        </p>
      </div>

      {/* Your encrypted cloud keys (sign-in required for this part only). */}
      <section className="neon-card rounded-lg p-3 sm:p-6 mb-6 sm:mb-8 border border-neon-cyan/30">
        <h2 className="text-sm tracking-label font-bold neon-text mb-4 font-mono">[ YOUR_CLOUD_KEYS ]</h2>
        {loading ? (
          <p className="font-mono text-sm text-neon-cyan animate-pulse">&gt; CHECKING_SESSION…</p>
        ) : user ? (
          <>
            <CredentialManager onEditingChange={setGuideFor} />
            <p className="mt-4 text-xs text-slate-400">Keys saved? <Link href="/regions" className="text-neon-cyan hover:underline">Regions</Link> shows where each cloud will let you launch (quota, region switched on) and how to fix the rest.</p>
          </>
        ) : (
          <div className="text-sm text-slate-300 space-y-3">
            <p>Sign in to add your cloud keys. Each account only ever sees and uses its own keys.</p>
            <div className="flex gap-2">
              <Link href="/login?next=/settings" className="btn-neon">Sign in</Link>
              <Link href="/login?mode=signup&next=/settings" className="btn-neon-magenta">Create account</Link>
            </div>
          </div>
        )}
      </section>

      {/* Detailed per-cloud setup instructions. `selected` makes the guide
          jump to whichever cloud's form you opened above. */}
      <CloudSetupGuide selected={guideFor} />

      {/* Troubleshooting: native <details> elements open and close on click
          with no JavaScript. `group` + `group-open:` (Tailwind) flips the
          arrow when its <details> is open. */}
      <div className="neon-card rounded-lg border border-neon-cyan/30 p-3 sm:p-6">
        <h3 className="text-sm tracking-label font-bold neon-text mb-2 font-mono">[ TROUBLESHOOTING ]</h3>
        <p className="text-xs text-slate-400 mb-6 max-w-3xl">
          The error text shown is what the cloud usually says. Click one to see what it means and how to fix it.
        </p>
        <div className="space-y-2">
          {TROUBLESHOOTING.map((item) => (
            <details key={item.title} className="group rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
              <summary className="cursor-pointer list-none flex justify-between items-center gap-4 text-xs font-mono">
                <span>
                  <span className="label mr-2">{item.cloud}</span>
                  <span className="text-slate-200">{item.title}</span>
                </span>
                <span className="text-neon-cyan/60 group-open:rotate-180 transition">▼</span>
              </summary>
              <ul className="mt-3 space-y-1.5 text-xs text-slate-300 leading-relaxed list-disc pl-5">
                {item.fixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
