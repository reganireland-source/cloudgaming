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
      // In production, this would be a real API call to /api/auth/cloud-credentials
      // const response = await fetch('/api/auth/cloud-credentials', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     provider: selectedProvider,
      //     credentials
      //   })
      // });

      // Mock success for demo
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

    // In production: DELETE /api/auth/cloud-credentials/:provider
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

      {/* How to Get Credentials */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-6">
        <h3 className="text-xl font-semibold text-gray-900 mb-4">How to Get Credentials</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h4 className="font-semibold text-gray-900 mb-3">☁️ AWS</h4>
            <ol className="text-sm text-gray-700 space-y-2">
              <li>1. Go to IAM Console</li>
              <li>2. Create new access key</li>
              <li>3. Save Access Key ID and Secret Access Key</li>
              <li>4. Paste into form above</li>
              <li className="text-xs text-gray-500 mt-3">
                ⚠️ Keep secret key safe - anyone with it can access your AWS account
              </li>
            </ol>
          </div>

          <div>
            <h4 className="font-semibold text-gray-900 mb-3">🔵 Azure</h4>
            <ol className="text-sm text-gray-700 space-y-2">
              <li>1. Go to Azure Portal → App registrations</li>
              <li>2. Create a new app registration</li>
              <li>3. Generate client secret</li>
              <li>4. Get Subscription ID, Tenant ID, Client ID</li>
              <li className="text-xs text-gray-500 mt-3">
                Give "Contributor" role on subscription
              </li>
            </ol>
          </div>

          <div>
            <h4 className="font-semibold text-gray-900 mb-3">🟠 GCP</h4>
            <ol className="text-sm text-gray-700 space-y-2">
              <li>1. Go to GCP Console → Service Accounts</li>
              <li>2. Create service account</li>
              <li>3. Create and download JSON key</li>
              <li>4. Paste the entire JSON content</li>
              <li className="text-xs text-gray-500 mt-3">
                Grant "Compute Admin" role
              </li>
            </ol>
          </div>

          <div>
            <h4 className="font-semibold text-gray-900 mb-3">🔴 Oracle</h4>
            <ol className="text-sm text-gray-700 space-y-2">
              <li>1. Go to Oracle Cloud → User Settings</li>
              <li>2. Generate API key pair</li>
              <li>3. Get your tenancy OCID and user OCID</li>
              <li>4. Paste private key content</li>
              <li className="text-xs text-gray-500 mt-3">
                Save the fingerprint shown
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
