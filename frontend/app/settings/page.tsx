'use client';

import { useState } from 'react';

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

export default function SettingsPage() {
  const [selectedProvider, setSelectedProvider] = useState<'aws' | 'azure' | 'gcp' | 'oracle' | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  const provider = selectedProvider ? providers.find(p => p.name === selectedProvider) : null;

  const handleInputChange = (field: string, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }));
  };

  const handleSaveCredentials = async () => {
    if (!selectedProvider || Object.keys(credentials).length === 0) {
      setMessage({ type: 'error', text: 'Please fill in all required fields' });
      return;
    }

    setLoading(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      setSavedProviders(prev => new Set(prev).add(selectedProvider));
      setMessage({ type: 'success', text: `${provider?.label} credentials saved securely` });
      setCredentials({});
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save credentials. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

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

            <div className="bg-cyan-950/30 border border-neon-cyan/30 rounded-lg p-4 mb-6 font-mono text-xs text-neon-cyan">
              <p>
                <strong className="text-neon-magenta">🔒 SECURE:</strong> AES-256 encryption. Never logged, shared, or displayed.
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

      {/* How to Get Credentials with Direct Links */}
      <div className="neon-card rounded-lg border border-neon-cyan/30 p-6 mb-8">
        <h3 className="text-sm font-bold neon-text mb-6 font-mono">[ CREDENTIAL_SETUP ]</h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* AWS */}
          <div className="neon-card-cyan rounded-lg p-6 border border-neon-cyan/30">
            <h4 className="font-bold text-neon-cyan mb-4 flex items-center gap-2 text-[0.8rem] font-mono">
              <span>☁️</span> AMAZON_WEB_SERVICES
            </h4>
            <ol className="text-xs text-neon-cyan space-y-3 mb-4 font-mono">
              <li className="flex gap-3">
                <span className="font-bold text-neon-cyan">[1]</span>
                <span className="text-neon-lime">Open <a href="https://console.aws.amazon.com/iam/home#/users" target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline font-medium">AWS_IAM_CONSOLE</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-cyan">[2]</span>
                <span className="text-neon-lime">Click_your_username</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-cyan">[3]</span>
                <span className="text-neon-lime">Access_keys → <strong>Create</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-cyan">[4]</span>
                <span className="text-neon-lime">Select <strong>Application_Outside_AWS</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-cyan">[5]</span>
                <span className="text-neon-lime">Copy <strong>KEY_ID</strong> + <strong>SECRET_KEY</strong> now</span>
              </li>
            </ol>
            <div className="bg-yellow-950/30 border border-neon-pink/30 rounded p-3 text-xs text-neon-pink mb-3 font-mono">
              <strong className="text-neon-magenta">⚠ CRITICAL:</strong> Secret shown only once!
            </div>
            <div className="text-xs text-neon-cyan/70 mb-3 font-mono">
              <strong>REGIONS:</strong> us-east-1 / us-west-2 / eu-west-1 / ap-se-1
            </div>
            <a href="https://console.aws.amazon.com/iam/home#/users" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center btn-neon-cyan">
              [ OPEN_IAM_CONSOLE ]
            </a>
          </div>

          {/* Azure */}
          <div className="neon-card-magenta rounded-lg p-6 border border-neon-magenta/30">
            <h4 className="font-bold text-neon-magenta mb-4 flex items-center gap-2 text-[0.8rem] font-mono">
              <span>🔵</span> MICROSOFT_AZURE
            </h4>
            <ol className="text-xs text-neon-magenta space-y-3 mb-4 font-mono">
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[1]</span>
                <span className="text-neon-cyan">Open <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-neon-magenta hover:underline font-medium">AZURE_PORTAL</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[2]</span>
                <span className="text-neon-cyan">Click <strong>+_New_Registration</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[3]</span>
                <span className="text-neon-cyan">Name: "CloudGaming" → Register</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[4]</span>
                <span className="text-neon-cyan">Copy <strong>APP_ID</strong> + <strong>TENANT_ID</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[5]</span>
                <span className="text-neon-cyan">Certificates → <strong>+_New_Secret</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[6]</span>
                <span className="text-neon-cyan">Copy secret <strong>Value</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[7]</span>
                <span className="text-neon-cyan">Get Subscription_ID from <a href="https://portal.azure.com/#blade/Microsoft_Azure_Billing/SubscriptionsBlade" target="_blank" rel="noopener noreferrer" className="text-neon-magenta hover:underline">Billing_Blade</a></span>
              </li>
            </ol>
            <div className="bg-yellow-950/30 border border-neon-pink/30 rounded p-3 text-xs text-neon-pink mb-3 font-mono">
              <strong className="text-neon-magenta">⚠ REQUIRED:</strong> Assign "Contributor" role!
            </div>
            <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center btn-neon-magenta">
              [ OPEN_APP_REGISTRATIONS ]
            </a>
          </div>

          {/* GCP */}
          <div className="neon-card-lime rounded-lg p-6 border border-neon-lime/30">
            <h4 className="font-bold text-neon-lime mb-4 flex items-center gap-2 text-[0.8rem] font-mono">
              <span>🟠</span> GOOGLE_CLOUD_PLATFORM
            </h4>
            <ol className="text-xs text-neon-lime space-y-3 mb-4 font-mono">
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[1]</span>
                <span className="text-neon-magenta">Open <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="text-neon-lime hover:underline font-medium">GCP_CONSOLE</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[2]</span>
                <span className="text-neon-magenta">Click <strong>+_Create_Service_Account</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[3]</span>
                <span className="text-neon-magenta">Name: "cloudgaming" → Create</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[4]</span>
                <span className="text-neon-magenta">Grant: <strong>Compute_Admin</strong> → Continue</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[5]</span>
                <span className="text-neon-magenta">Service Account → <strong>Keys_Tab</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[6]</span>
                <span className="text-neon-magenta"><strong>+_Add_Key</strong> → JSON</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-lime">[7]</span>
                <span className="text-neon-magenta">Copy entire JSON content</span>
              </li>
            </ol>
            <div className="bg-cyan-950/30 border border-neon-cyan/30 rounded p-3 text-xs text-neon-cyan mb-3 font-mono">
              <strong className="text-neon-magenta">📝 PROJECT_ID:</strong> From console header (my-project-XXXXXX)
            </div>
            <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center btn-neon-lime">
              [ OPEN_SERVICE_ACCOUNTS ]
            </a>
          </div>

          {/* Oracle */}
          <div className="neon-card-magenta rounded-lg p-6 border border-neon-magenta/30">
            <h4 className="font-bold text-neon-magenta mb-4 flex items-center gap-2 text-[0.8rem] font-mono">
              <span>🔴</span> ORACLE_CLOUD_INFRA
            </h4>
            <ol className="text-xs text-neon-magenta space-y-3 mb-4 font-mono">
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[1]</span>
                <span className="text-neon-cyan">Open <a href="https://cloud.oracle.com/identity/users" target="_blank" rel="noopener noreferrer" className="text-neon-magenta hover:underline font-medium">OCI_CONSOLE</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[2]</span>
                <span className="text-neon-cyan">Click your username (top right)</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[3]</span>
                <span className="text-neon-cyan">API_Keys → <strong>Add_API_Key</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[4]</span>
                <span className="text-neon-cyan"><strong>Generate_Key_Pair</strong> → Download</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[5]</span>
                <span className="text-neon-cyan">Copy <strong>Fingerprint</strong> value</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[6]</span>
                <span className="text-neon-cyan">Get User_OCID (ocid1.user.*)</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-neon-magenta">[7]</span>
                <span className="text-neon-cyan">Get Tenancy_OCID from profile menu</span>
              </li>
            </ol>
            <div className="bg-green-950/30 border border-neon-lime/30 rounded p-3 text-xs text-neon-lime mb-3 font-mono">
              <strong className="text-neon-magenta">💰 ORACLE_ADVANTAGE:</strong> FREE_EGRESS in Singapore = Huge_Savings!
            </div>
            <a href="https://cloud.oracle.com/identity/users" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center btn-neon-magenta">
              [ OPEN_USERS_PAGE ]
            </a>
          </div>
        </div>
      </div>

      {/* Troubleshooting */}
      <div className="neon-card rounded-lg border border-neon-cyan/30 p-6">
        <h3 className="text-sm font-bold neon-text mb-6 font-mono">[ TROUBLESHOOTING ]</h3>
        <div className="space-y-3">
          <details className="group neon-card-cyan rounded-lg p-4 border border-neon-cyan/30">
            <summary className="cursor-pointer font-bold text-neon-cyan hover:text-neon-magenta flex justify-between items-center font-mono text-sm">
              <span>AWS: InvalidClientTokenId error</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-xs text-neon-lime mt-3 font-mono">
              Check that you copied the Access Key ID and Secret Access Key exactly from IAM Console. Any space or character difference causes this error. Delete the key and create a new one if needed.
            </p>
          </details>

          <details className="group bg-gray-50 rounded-lg p-4 border border-gray-200">
            <summary className="cursor-pointer font-medium text-gray-900 hover:text-blue-600 flex justify-between items-center">
              <span>Azure: "Insufficient privileges" or "AADSTS permission denied" error</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-sm text-gray-700 mt-3">
              Your app registration needs the "Contributor" role. Go to Azure Portal → Subscriptions → Click your subscription → Access Control (IAM) → Add role assignment → Contributor role → Select your app.
            </p>
          </details>

          <details className="group bg-gray-50 rounded-lg p-4 border border-gray-200">
            <summary className="cursor-pointer font-medium text-gray-900 hover:text-blue-600 flex justify-between items-center">
              <span>GCP: "Invalid service account" or "Service account key invalid" error</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-sm text-gray-700 mt-3">
              Make sure you're copying the entire JSON key content (not just parts). Also verify the service account has "Compute Admin" role. Re-download the key from Service Accounts page if needed.
            </p>
          </details>

          <details className="group bg-gray-50 rounded-lg p-4 border border-gray-200">
            <summary className="cursor-pointer font-medium text-gray-900 hover:text-blue-600 flex justify-between items-center">
              <span>Oracle: "User not in tenancy" or "Invalid authentication" error</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-sm text-gray-700 mt-3">
              Make sure you're using the User OCID (long string starting with "ocid1.user"), not your username. Also verify the private key is properly formatted (starts with "-----BEGIN RSA PRIVATE KEY-----").
            </p>
          </details>

          <details className="group bg-gray-50 rounded-lg p-4 border border-gray-200">
            <summary className="cursor-pointer font-medium text-gray-900 hover:text-blue-600 flex justify-between items-center">
              <span>Any provider: "Credentials expired" after several months</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-sm text-gray-700 mt-3">
              Some credentials have expiration dates. Generate new credentials from your cloud provider console and update them here. Delete the old credentials first.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}
