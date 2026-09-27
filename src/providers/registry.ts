/**
 * ============================================================================
 * src/providers/registry.ts — ONE PLACE LISTING EVERY CLOUD'S MODULES
 * ============================================================================
 * The routes read catalogs (launch form choices) and setup modules (Config
 * page forms + live checks) from here, so they never need to know which
 * clouds exist. Adding a cloud = adding it to these two tables.
 * ============================================================================
 */

import type { ProviderCatalog, ProviderName, ProviderSetupModule } from './shared/types';
import { GCP_CATALOG } from './gcp/catalog';
import { GCP_SETUP } from './gcp/checks';
import { AWS_CATALOG } from './aws/catalog';
import { AWS_SETUP } from './aws/checks';
import { AZURE_CATALOG } from './azure/catalog';
import { AZURE_SETUP } from './azure/checks';
import { ORACLE_CATALOG } from './oracle/catalog';
import { ORACLE_SETUP } from './oracle/checks';

export const CATALOGS: Record<ProviderName, ProviderCatalog> = {
  gcp: GCP_CATALOG,
  aws: AWS_CATALOG,
  azure: AZURE_CATALOG,
  oracle: ORACLE_CATALOG,
};

export const SETUP_MODULES: Record<ProviderName, ProviderSetupModule> = {
  gcp: GCP_SETUP,
  aws: AWS_SETUP,
  azure: AZURE_SETUP,
  oracle: ORACLE_SETUP,
};

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'gcp' || value === 'aws' || value === 'azure' || value === 'oracle';
}
