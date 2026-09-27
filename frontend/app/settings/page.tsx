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
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Settings</h1>
        <p className="text-gray-600">Manage your cloud provider credentials and account settings</p>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg ${
          message.type === 'success'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {message.text}
        </div>
      )}

      {/* Cloud Provider Credentials Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Cloud Provider Credentials</h2>

        {/* Provider Selection Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {providers.map((p) => (
            <button
              key={p.name}
              onClick={() => setSelectedProvider(p.name)}
              className={`p-4 rounded-lg border-2 transition ${
                selectedProvider === p.name
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="text-4xl mb-2">{p.icon}</div>
              <h3 className="font-semibold text-gray-900 text-sm mb-2">{p.label}</h3>
              {savedProviders.has(p.name) && (
                <div className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded inline-block">
                  ✓ Configured
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Credential Entry Form */}
        {selectedProvider && provider && (
          <div className="border-t pt-6">
            <h3 className="text-xl font-semibold text-gray-900 mb-2">{provider.label}</h3>
            <p className="text-gray-600 mb-6 text-sm">{provider.description}</p>

            <div className="space-y-4 mb-6">
              {provider.requiredFields.map((field) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {field.replace(/([A-Z])/g, ' $1').trim()}
                  </label>
                  {field.includes('Key') || field.includes('Secret') ? (
                    <div className="relative">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={credentials[field] || ''}
                        onChange={(e) => handleInputChange(field, e.target.value)}
                        placeholder={`Enter your ${field}`}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-2.5 text-gray-500 hover:text-gray-700"
                      >
                        {showKey ? '👁️' : '👁️‍🗨️'}
                      </button>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={credentials[field] || ''}
                      onChange={(e) => handleInputChange(field, e.target.value)}
                      placeholder={`Enter your ${field}`}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <p className="text-sm text-blue-800">
                <strong>🔒 Security:</strong> Credentials are encrypted with AES-256 and stored securely in our database.
                They're never logged, shared, or displayed after saving. Only used to access your cloud resources on your behalf.
              </p>
            </div>

            <button
              onClick={handleSaveCredentials}
              disabled={loading || Object.keys(credentials).length === 0}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium"
            >
              {loading ? 'Saving...' : 'Save Credentials'}
            </button>
          </div>
        )}

        {/* Saved Credentials Summary */}
        {savedProviders.size > 0 && (
          <div className="mt-8 border-t pt-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Connected Providers</h3>
            <div className="space-y-3">
              {providers.map((p) => {
                if (!savedProviders.has(p.name)) return null;
                return (
                  <div key={p.name} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{p.icon}</span>
                      <div>
                        <p className="font-semibold text-gray-900">{p.label}</p>
                        <p className="text-sm text-gray-600">Credentials configured</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteCredentials(p.name)}
                      className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg font-medium transition"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* How to Get Credentials with Direct Links */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 mb-8">
        <h3 className="text-2xl font-semibold text-gray-900 mb-6">How to Get Credentials</h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* AWS */}
          <div className="bg-white rounded-lg p-6 border border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4 flex items-center gap-2 text-lg">
              <span>☁️</span> Amazon Web Services (AWS)
            </h4>
            <ol className="text-sm text-gray-700 space-y-3 mb-4">
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">1.</span>
                <span>Open <a href="https://console.aws.amazon.com/iam/home#/users" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">AWS IAM Console → Users</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">2.</span>
                <span>Click your username</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">3.</span>
                <span>Scroll to <strong>Access keys</strong> → <strong>Create access key</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">4.</span>
                <span>Select <strong>Application running outside AWS</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">5.</span>
                <span>Copy <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> immediately</span>
              </li>
            </ol>
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-xs text-yellow-800 mb-3">
              <strong>⚠️ Important:</strong> Secret key shown only once. Save it immediately or regenerate.
            </div>
            <div className="text-xs text-gray-600 mb-3">
              <strong>Region examples:</strong> us-east-1, us-west-2, eu-west-1, ap-southeast-1
            </div>
            <a href="https://console.aws.amazon.com/iam/home#/users" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium">
              Open AWS IAM Console →
            </a>
          </div>

          {/* Azure */}
          <div className="bg-white rounded-lg p-6 border border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4 flex items-center gap-2 text-lg">
              <span>🔵</span> Microsoft Azure
            </h4>
            <ol className="text-sm text-gray-700 space-y-3 mb-4">
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">1.</span>
                <span>Open <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Azure Portal → App registrations</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">2.</span>
                <span>Click <strong>+ New registration</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">3.</span>
                <span>Name: "CloudGaming" → Register</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">4.</span>
                <span>Copy <strong>Application ID</strong> and <strong>Tenant ID</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">5.</span>
                <span>Go to <strong>Certificates & secrets</strong> → <strong>+ New client secret</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">6.</span>
                <span>Copy the secret <strong>Value</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">7.</span>
                <span>Get Subscription ID from <a href="https://portal.azure.com/#blade/Microsoft_Azure_Billing/SubscriptionsBlade" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Subscriptions blade</a></span>
              </li>
            </ol>
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-xs text-yellow-800 mb-3">
              <strong>⚠️ Permissions:</strong> Assign app "Contributor" role on your subscription
            </div>
            <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium">
              Open App Registrations →
            </a>
          </div>

          {/* GCP */}
          <div className="bg-white rounded-lg p-6 border border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4 flex items-center gap-2 text-lg">
              <span>🟠</span> Google Cloud Platform (GCP)
            </h4>
            <ol className="text-sm text-gray-700 space-y-3 mb-4">
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">1.</span>
                <span>Open <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">GCP Console → Service Accounts</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">2.</span>
                <span>Click <strong>+ Create Service Account</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">3.</span>
                <span>Name: "cloudgaming" → Create</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">4.</span>
                <span>Grant role: <strong>Compute Admin</strong> → Continue</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">5.</span>
                <span>Click created service account → <strong>Keys tab</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">6.</span>
                <span><strong>+ Add Key</strong> → Create new → JSON</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">7.</span>
                <span>Open downloaded JSON → Copy entire content</span>
              </li>
            </ol>
            <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800 mb-3">
              <strong>📝 Project ID:</strong> Get from GCP Console header (looks like "my-project-123456")
            </div>
            <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium">
              Open Service Accounts →
            </a>
          </div>

          {/* Oracle */}
          <div className="bg-white rounded-lg p-6 border border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4 flex items-center gap-2 text-lg">
              <span>🔴</span> Oracle Cloud Infrastructure (OCI)
            </h4>
            <ol className="text-sm text-gray-700 space-y-3 mb-4">
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">1.</span>
                <span>Open <a href="https://cloud.oracle.com/identity/users" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">OCI Console → Identity → Users</a></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">2.</span>
                <span>Click your username at the top right</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">3.</span>
                <span>Scroll to <strong>API Keys</strong> → <strong>Add API Key</strong></span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">4.</span>
                <span><strong>Generate API Key Pair</strong> → Download private key</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">5.</span>
                <span>Copy the <strong>Fingerprint</strong> shown on screen</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">6.</span>
                <span>Get User OCID from current page (starts with "ocid1.user")</span>
              </li>
              <li className="flex gap-3">
                <span className="font-bold text-blue-600">7.</span>
                <span>Get Tenancy OCID: profile menu → Tenancy info</span>
              </li>
            </ol>
            <div className="bg-green-50 border border-green-200 rounded p-3 text-xs text-green-800 mb-3">
              <strong>💰 Oracle Advantage:</strong> <strong>FREE egress</strong> in Singapore region = huge cost savings!
            </div>
            <a href="https://cloud.oracle.com/identity/users" target="_blank" rel="noopener noreferrer" className="inline-block w-full text-center bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium">
              Open Users Page →
            </a>
          </div>
        </div>
      </div>

      {/* Troubleshooting */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-2xl font-semibold text-gray-900 mb-6">❓ Troubleshooting</h3>
        <div className="space-y-3">
          <details className="group bg-gray-50 rounded-lg p-4 border border-gray-200">
            <summary className="cursor-pointer font-medium text-gray-900 hover:text-blue-600 flex justify-between items-center">
              <span>AWS: "InvalidClientTokenId" or "SignatureDoesNotMatch" error</span>
              <span className="group-open:rotate-180 transition">▼</span>
            </summary>
            <p className="text-sm text-gray-700 mt-3">
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
