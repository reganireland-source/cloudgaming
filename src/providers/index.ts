/**
 * ============================================================================
 * src/providers/index.ts — "GIVE ME THE RIGHT CLOUD OBJECT FOR 'aws'"
 * ============================================================================
 *
 * A tiny FACTORY: code elsewhere says getProvider('aws', credentials) and
 * gets back a ready-to-use AWSProvider, without needing to know which class
 * that is or import it directly. Adding a new cloud later means adding one
 * line to the `providers` table below.
 * ============================================================================
 */

import { CloudProvider } from './Provider';
import { AWSProvider } from './AWSProvider';
import { AzureProvider } from './AzureProvider';
import { GCPProvider } from './GCPProvider';
import { OracleProvider } from './OracleProvider';

// Lookup table: provider name -> the CLASS to create for it.
// The type `new (...args: any[]) => CloudProvider` reads as "something you
// can call with `new` that produces a CloudProvider" — i.e. a class.
const providers: Record<string, new (...args: any[]) => CloudProvider> = {
  aws: AWSProvider,
  azure: AzureProvider,
  gcp: GCPProvider,
  oracle: OracleProvider,
};

/**
 * Create the provider object for a cloud.
 *
 * @param providerName 'aws' | 'azure' | 'gcp' | 'oracle' (any capitalisation)
 * @param credentials  that user's login details for the cloud (from the
 *                     cloud_credentials table), passed to the class constructor
 * @throws if the name isn't one we support
 */
export function getProvider(providerName: string, credentials: any): CloudProvider {
  // .toLowerCase() so 'AWS', 'Aws' and 'aws' all work.
  const ProviderClass = providers[providerName.toLowerCase()];
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  // `new ProviderClass(...)` creates an instance of whichever class we found.
  return new ProviderClass(credentials);
}

// Re-export the base class so other files can import everything provider-
// related from this one place.
export { CloudProvider };
