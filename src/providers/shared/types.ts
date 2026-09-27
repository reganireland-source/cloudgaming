/**
 * ============================================================================
 * src/providers/shared/types.ts — WHAT EVERY CLOUD MODULE MUST PROVIDE
 * ============================================================================
 *
 * Besides the CloudProvider class (Provider.ts), each cloud has two small
 * modules the rest of the app reads generically:
 *
 *   <cloud>/catalog.ts  → a ProviderCatalog: regions, machine shapes and
 *                          price estimates. Drives the launch form.
 *   <cloud>/checks.ts   → a ProviderSetupModule: which fields the Config
 *                          page asks for, and runChecks(), which validates
 *                          what the user typed and tests it live against the
 *                          cloud, returning a checklist with tips.
 *
 * Both are registered in src/providers/registry.ts.
 * ============================================================================
 */

export type ProviderName = 'aws' | 'azure' | 'gcp' | 'oracle';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogRegion {
  id: string;             // the cloud's region id, e.g. 'ap-southeast-1'
  name: string;           // friendly name, e.g. 'Singapore'
  lat: number;            // approximate location, for "nearest to you"
  lng: number;
  gpus: string[];         // GPU models offered here, e.g. ['T4', 'A10G']
  egressPerGb: number;    // approx $/GB sent to the internet
}

export interface CatalogShape {
  id: string;             // stored in machines.instance_type
  label: string;          // e.g. 'T4 · 4 vCPU · 16 GB RAM'
  gpuModel: string;       // e.g. 'T4'
  vcpus: number;
  memoryGb: number;
  bestFor: string;        // one line of advice for the launch form
}

export interface ProviderCatalog {
  provider: ProviderName;
  label: string;              // 'Google Cloud'
  supportsSpot: boolean;      // can the launch form offer "spot" pricing?
  spotLabel: string;          // what this cloud calls it ('Spot VM', 'Preemptible'...)
  defaultRegion: string;
  defaultDiskGb: number;
  minDiskGb: number;
  regions: CatalogRegion[];
  shapes: CatalogShape[];
  /** Estimated $/hour (0 if unknown). */
  estimateHourly(shapeId: string, regionId: string, spot: boolean): number;
  /** Approx $/GB/month for the machine's disk while it exists (also when stopped). */
  diskPerGbMonth: number;
  priceNote: string;          // e.g. 'Estimates from list prices; excludes tax.'
}

// ---------------------------------------------------------------------------
// Credentials: form fields + live checks
// ---------------------------------------------------------------------------

export interface CredentialField {
  key: string;            // name in the submitted object, e.g. 'accessKeyId'
  label: string;          // 'Access key ID'
  type: 'text' | 'password' | 'textarea' | 'file-text';
  //   'file-text' = a textarea that ALSO offers "Upload file" (read in the browser)
  required: boolean;
  placeholder?: string;
  help?: string;          // one line under the field: where to find this value
  accept?: string;        // for file-text: e.g. '.json' or '.pem'
  secret?: boolean;       // never echoed back; masked in the UI
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CredentialCheck {
  id: string;             // e.g. 'format', 'signin', 'gpu-quota'
  label: string;          // 'Key file format'
  status: CheckStatus;    // pass ✓, warn ⚠ (saved anyway), fail ✗ (not saved), skip –
  message: string;        // what we found
  tip?: string;           // what to do about it
  consoleUrl?: string;    // link that fixes it
  consoleLabel?: string;
}

export interface CheckOutcome {
  ok: boolean;                        // true = no 'fail' checks → safe to save
  checks: CredentialCheck[];
  summary: string;                    // one line, e.g. '5 passed, 1 warning'
  secret?: unknown;                   // the cleaned-up credentials to encrypt & store
  metadata: Record<string, unknown>;  // NON-secret summary for the UI (ids, emails, key id...)
}

export interface ProviderSetupModule {
  fields: CredentialField[];
  /** Short intro shown above the form. */
  intro: string;
  /**
   * Validate the submitted values and test them live. Must NEVER throw for
   * user mistakes — report them as 'fail' checks with tips instead.
   * @param input  raw form values (strings), keyed by CredentialField.key
   * @param opts.region region to check GPU quotas / availability in
   */
  runChecks(input: Record<string, string>, opts: { region?: string }): Promise<CheckOutcome>;
}

/** Helper: build the outcome (ok + summary) from a list of checks. */
export function outcome(checks: CredentialCheck[], secret: unknown, metadata: Record<string, unknown>): CheckOutcome {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const fails = count('fail');
  const warns = count('warn');
  const parts = [`${count('pass')} passed`];
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  if (fails) parts.push(`${fails} failed`);
  return { ok: fails === 0, checks, summary: parts.join(', '), secret: fails === 0 ? secret : undefined, metadata };
}

// ---------------------------------------------------------------------------
// Setup progress (read from the machine's serial console)
// ---------------------------------------------------------------------------

export interface SetupStage {
  percent: number;
  key: string;       // e.g. 'drivers', 'ready', 'failed'
  message: string;
}
