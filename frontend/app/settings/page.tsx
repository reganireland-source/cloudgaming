'use client';
// ↑ Client component: the page keeps form state and reacts to clicks.

/**
 * ============================================================================
 * frontend/app/settings/page.tsx — THE "CONFIG" PAGE (/settings)
 * ============================================================================
 *
 * Three sections, top to bottom:
 *   1. CLOUD_PROVIDERS — pick a cloud, type in its credentials.
 *   2. CREDENTIAL_SETUP_GUIDE — detailed, step-by-step instructions for
 *      getting those credentials (components/CloudSetupGuide.tsx).
 *   3. TROUBLESHOOTING — common error messages and what they mean.
 *
 * KNOWN ISSUES (be aware before relying on this page)
 * -----------------------------------------------------
 * - SAVING IS NOT CONNECTED YET. handleSaveCredentials only waits one second
 *   and marks the cloud "READY" in this page's memory. Nothing is sent to the
 *   backend, and a page refresh forgets it. The backend reads cloud
 *   credentials from its own Railway environment variables instead.
 * - When saving IS wired up, the backend must encrypt the secrets before
 *   storing them. It does not do that today, so the page no longer claims it.
 * ============================================================================
 */

import { useState } from 'react';
import CloudSetupGuide from '@/components/CloudSetupGuide';

// One cloud's entry in the picker. `requiredFields` drives the form: one
// input box is drawn per name, and names containing "Key" or "Secret" get a
// hidden (password-style) box.
interface CloudProvider {
  name: 'aws' | 'azure' | 'gcp' | 'oracle';
  label: string;
  icon: string;
  requiredFields: string[];
  description: string;
}

const providers: CloudProvider[] = [
  {
    name: 'aws',
    label: 'Amazon Web Services',
    icon: '☁️',
    requiredFields: ['accessKeyId', 'secretAccessKey', 'region'],
    description: 'AWS EC2 for g4/g5 GPU instances with CloudWatch monitoring',
  },
  {
    name: 'azure',
    label: 'Microsoft Azure',
    icon: '🔵',
    requiredFields: ['subscriptionId', 'clientId', 'clientSecret', 'tenantId', 'resourceGroup'],
    description: 'Azure VM with NV-series GPUs and monitoring',
  },
  {
    name: 'gcp',
    label: 'Google Cloud Platform',
    icon: '🟠',
    requiredFields: ['projectId', 'serviceAccountKey'],
    description: 'GCP Compute Engine with L4/A100 GPUs',
  },
  {
    name: 'oracle',
    label: 'Oracle Cloud',
    icon: '🔴',
    requiredFields: ['compartmentId', 'userId', 'tenancy', 'fingerprint', 'privateKey'],
    description: 'Oracle VM instances with free egress in Singapore region',
  },
];

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
      'Credentials can expire or be rotated by an admin. Create new ones and update the Railway variables.',
      'Check the status lights at the top of the page: a red cloud light means the backend could not reach that cloud.',
    ],
  },
];

export default function SettingsPage() {
  // The page's memory (useState — see components/SystemStatusBar.tsx):
  //   selectedProvider — which cloud card is clicked (null = none yet)
  //   credentials      — what's typed in the boxes, as { fieldName: value }
  //   savedProviders   — clouds marked READY (in memory only, see KNOWN ISSUES)
  //   message          — the green/red banner at the top
  //   showKey          — reveal the hidden secret boxes?
  const [selectedProvider, setSelectedProvider] = useState<'aws' | 'azure' | 'gcp' | 'oracle' | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  const provider = selectedProvider ? providers.find(p => p.name === selectedProvider) : null;

  // Runs on every keystroke. `{ ...prev, [field]: value }` copies the old
  // object and overwrites one key (React needs a NEW object to notice a change).
  const handleInputChange = (field: string, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }));
  };

  // PLACEHOLDER SAVE — see KNOWN ISSUES above. The fake one-second wait
  // stands in for a future POST to the backend.
  // Note the check below only requires at least ONE field to be filled in,
  // not all of them.
  const handleSaveCredentials = async () => {
    if (!selectedProvider || Object.keys(credentials).length === 0) {
      setMessage({ type: 'error', text: 'Please fill in all required fields' });
      return;
    }

    setLoading(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      setSavedProviders(prev => new Set(prev).add(selectedProvider));
      setMessage({ type: 'success', text: `${provider?.label} marked ready (this browser session only — not yet sent to the backend)` });
      setCredentials({});
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save credentials. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Un-marks a cloud as READY. confirm() shows the browser's OK/Cancel box.
  const handleDeleteCredentials = async (providerName: string) => {
    if (!confirm(`Remove ${providerName} credentials?`)) return;
    setSavedProviders(prev => {
      const updated = new Set(prev);
      updated.delete(providerName);
      return updated;
    });
    setMessage({ type: 'success', text: `${providerName} credentials removed` });
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold neon-text mb-2 font-mono">[ CONFIGURATION ]</h1>
        <p className="font-mono text-neon-lime text-sm">
          {'> manage_cloud_provider_credentials_and_settings'.toUpperCase()}
        </p>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg font-mono text-sm border-l-4 ${
          message.type === 'success'
            ? 'border-neon-lime bg-green-950/30 text-neon-lime'
            : 'border-neon-pink bg-red-950/30 text-neon-pink'
        }`}>
          {message.type === 'success' ? '✓' : '✗'} {message.text}
        </div>
      )}

      {/* Cloud Provider Credentials Section */}
      <div className="neon-card rounded-lg p-6 mb-8 border border-neon-cyan/30">
        <h2 className="text-sm tracking-label font-bold neon-text mb-6 font-mono">[ CLOUD_PROVIDERS ]</h2>

        {/* Provider Selection Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {providers.map((p) => (
            <button
              key={p.name}
              onClick={() => setSelectedProvider(p.name)}
              className={`p-4 rounded-lg border transition font-mono text-sm ${
                selectedProvider === p.name
                  ? 'neon-card-magenta border-neon-magenta'
                  : 'neon-card border-neon-cyan hover:border-neon-magenta hover:neon-card-magenta'
              }`}
            >
              <div className="text-2xl mb-2">{p.icon}</div>
              <h3 className="font-bold text-neon-cyan text-xs mb-2">{p.label}</h3>
              {savedProviders.has(p.name) && (
                <div className="text-xs border border-neon-lime/30 text-neon-lime px-2 py-1 rounded inline-block bg-green-950/20">
                  ✓ READY
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Credential Entry Form */}
        {selectedProvider && provider && (
          <div className="border-t border-neon-cyan/30 pt-6">
            <h3 className="text-sm font-bold neon-accent mb-2 font-mono">{provider.label}</h3>
            <p className="text-neon-lime mb-6 text-xs font-mono">{provider.description}</p>

            <div className="space-y-4 mb-6">
              {provider.requiredFields.map((field) => (
                <div key={field}>
                  <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">
                    {field.toUpperCase()}
                  </label>
                  {field.includes('Key') || field.includes('Secret') ? (
                    <div className="relative">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={credentials[field] || ''}
                        onChange={(e) => handleInputChange(field, e.target.value)}
                        placeholder={`[${field}]`}
                        className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-2.5 text-neon-lime hover:text-neon-cyan transition-colors"
                      >
                        {showKey ? '▓' : '▒'}
                      </button>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={credentials[field] || ''}
                      onChange={(e) => handleInputChange(field, e.target.value)}
                      placeholder={`[${field}]`}
                      className="input-neon w-full px-4 py-2 rounded font-mono text-sm"
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Honest status of the save button (see KNOWN ISSUES at the top). */}
            <div className="bg-amber-950/20 border border-amber-400/30 rounded-lg p-4 mb-6 text-xs text-slate-300 leading-relaxed">
              <p>
                <strong className="neon-amber">NOTE:</strong> Saving here is not connected to the backend yet — it only
                marks this cloud as ready until you refresh. To use a cloud today, set its credentials as variables
                on the Railway backend. Credentials are not yet encrypted at rest, so only use limited-access keys
                (the setup guide below creates exactly those).
              </p>
            </div>

            <button
              onClick={handleSaveCredentials}
              disabled={loading || Object.keys(credentials).length === 0}
              className="btn-neon-cyan disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '[ SAVING... ]' : '[ SAVE_CREDENTIALS ]'}
            </button>
          </div>
        )}

        {/* Saved Credentials Summary */}
        {savedProviders.size > 0 && (
          <div className="mt-8 border-t border-neon-magenta/30 pt-6">
            <h3 className="text-sm font-bold neon-accent mb-4 font-mono">[ CONNECTED_PROVIDERS ]</h3>
            <div className="space-y-3">
              {providers.map((p) => {
                if (!savedProviders.has(p.name)) return null;
                return (
                  <div key={p.name} className="flex items-center justify-between p-4 neon-card-magenta rounded-lg border border-neon-magenta/30">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{p.icon}</span>
                      <div className="font-mono">
                        <p className="font-bold text-neon-magenta text-sm">{p.label}</p>
                        <p className="text-xs text-neon-cyan/70">ready_to_use</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteCredentials(p.name)}
                      className="px-4 py-2 text-neon-pink hover:bg-red-950/30 rounded-lg font-bold transition border border-neon-pink/50 hover:border-neon-pink font-mono text-sm"
                    >
                      REVOKE
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Detailed per-cloud setup instructions. `selected` makes the guide
          jump to whichever cloud you clicked above. */}
      <CloudSetupGuide selected={selectedProvider} />

      {/* Troubleshooting: native <details> elements open and close on click
          with no JavaScript. `group` + `group-open:` (Tailwind) flips the
          arrow when its <details> is open. */}
      <div className="neon-card rounded-lg border border-neon-cyan/30 p-6">
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
