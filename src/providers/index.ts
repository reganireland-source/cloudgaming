import { CloudProvider } from './Provider';
import { AWSProvider } from './AWSProvider';
import { AzureProvider } from './AzureProvider';
import { GCPProvider } from './GCPProvider';
import { OracleProvider } from './OracleProvider';

const providers: Record<string, new (...args: any[]) => CloudProvider> = {
  aws: AWSProvider,
  azure: AzureProvider,
  gcp: GCPProvider,
  oracle: OracleProvider,
};

export function getProvider(providerName: string, credentials: any): CloudProvider {
  const ProviderClass = providers[providerName.toLowerCase()];
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  return new ProviderClass(credentials);
}

export { CloudProvider };
