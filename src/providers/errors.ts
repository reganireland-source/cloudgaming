/**
 * ============================================================================
 * src/providers/errors.ts — PLAIN-ENGLISH ERROR CARDS, FOR EVERY CLOUD
 * ============================================================================
 *
 * Cloud errors are precise but cryptic ("VcpuLimitExceeded",
 * "ZONE_RESOURCE_POOL_EXHAUSTED", "NotAuthorizedOrNotFound"...). Every
 * failure the user sees goes through toFriendlyError(), which turns it into
 * a FriendlyError: a title, what it means, numbered steps to fix it, and
 * (where useful) a link straight to the right console page. The frontend
 * renders this as an error card, so most problems can be fixed without
 * digging through a cloud console.
 *
 * Each cloud keeps its own list of recognised errors ("rules") in
 * src/providers/<cloud>/errors.ts. They are looked up by rulesFor()
 * below. Rules are checked top to bottom and the first match wins.
 * Anything unrecognised still becomes a card, with the original message kept
 * in `raw` so nothing is hidden.
 * ============================================================================
 */

import { GCP_RULES, setGcpProjectContext } from './gcp/errors';
import { AWS_RULES } from './aws/errors';
import { AZURE_RULES } from './azure/errors';
import { ORACLE_RULES } from './oracle/errors';

/** The plain-English error card the frontend renders. */
export interface FriendlyError {
  code: string;            // stable id, e.g. 'GPU_QUOTA'
  title: string;           // one line, e.g. "Your project has no GPU quota yet"
  explanation: string;     // what it means, in a sentence or two
  fixes: string[];         // numbered steps to fix it
  consoleUrl?: string;     // the one console page that fixes it, if any
  consoleLabel?: string;   // the button text for that link
  raw?: string;            // the original error message, for reference
  /** WHY it failed, in one word, so the card can say so plainly (see causeOf). */
  cause?: ErrorCause;
}

/**
 * The kind of problem behind an error. The error card leads with this, so
 * "your account has no GPU quota in this region" is never confused with
 * "the app is broken":
 *   quota       a limit on YOUR cloud account (GPU quota / service limit)
 *   region      the region isn't switched on / offered for your account
 *   permission  the app's key isn't allowed to do this (roles, policies)
 *   capacity    the cloud has no spare machines right now (temporary)
 *   credentials the saved key is wrong, expired or deleted
 *   account     billing / subscription / free-trial limits
 *   other       anything else
 */
export type ErrorCause = 'quota' | 'region' | 'permission' | 'capacity' | 'credentials' | 'account' | 'other';

const CAUSE_CODES: Record<Exclude<ErrorCause, 'other'>, string[]> = {
  quota: ['GPU_QUOTA_GLOBAL', 'GPU_QUOTA_REGION', 'QUOTA', 'AWS_GPU_QUOTA', 'AWS_SPOT_QUOTA', 'AZURE_GPU_QUOTA', 'AZURE_SPOT_QUOTA',
    'AZURE_QUOTA', 'OCI_SERVICE_LIMIT', 'OCI_COMPARTMENT_QUOTA'],
  region: ['OCI_REGION_NOT_SUBSCRIBED', 'AZURE_SKU_NOT_AVAILABLE', 'AWS_ACCOUNT_NOT_READY', 'GPU_NOT_IN_REGION', 'AWS_TYPE_NOT_IN_REGION', 'UNKNOWN_REGION'],
  permission: ['GCP_PERMISSION', 'AWS_PERMISSION', 'AZURE_PERMISSION', 'OCI_NOT_AUTHORIZED_OR_NOT_FOUND', 'ORG_POLICY_EXTERNAL_IP',
    'ORG_POLICY', 'AZURE_POLICY', 'GCP_API_DISABLED', 'AZURE_RP_NOT_REGISTERED'],
  capacity: ['ZONE_EXHAUSTED', 'AWS_NO_CAPACITY', 'AZURE_CAPACITY', 'OCI_OUT_OF_CAPACITY', 'AWS_TYPE_NOT_IN_ZONE', 'AWS_SUBNET_FULL'],
  credentials: ['GCP_KEY_INVALID', 'AWS_KEY_INVALID', 'AWS_KEY_EXPIRED', 'AWS_KEY_MISSING', 'AZURE_SECRET_INVALID', 'AZURE_SECRET_EXPIRED',
    'AZURE_APP_NOT_FOUND', 'AZURE_TENANT_NOT_FOUND', 'AZURE_SIGNIN', 'AZURE_CREDENTIALS_FORMAT', 'OCI_PRIVATE_KEY', 'OCI_NOT_AUTHENTICATED',
    'OCI_BAD_USER', 'OCI_BAD_TENANCY', 'OCI_BAD_FINGERPRINT', 'OCI_NO_PRIVATE_KEY', 'OCI_PUBLIC_KEY_GIVEN', 'GCP_KEY_WRONG_TYPE',
    'GCP_KEY_NOT_JSON', 'NO_CREDENTIALS', 'CREDENTIALS_UNREADABLE'],
  account: ['GCP_BILLING', 'AZURE_FREE_TRIAL', 'AZURE_SUBSCRIPTION_DISABLED', 'AZURE_SUBSCRIPTION_NOT_FOUND'],
};
const CAUSE_BY_CODE: Record<string, ErrorCause> = Object.fromEntries(
  (Object.entries(CAUSE_CODES) as Array<[ErrorCause, string[]]>).flatMap(([cause, codes]) => codes.map((c) => [c, cause]))
);
export function causeOf(code: string): ErrorCause {
  return CAUSE_BY_CODE[code] || 'other';
}

/**
 * An Error that already carries a FriendlyError. Our own code throws these
 * when it knows exactly what's wrong (e.g. "no credentials configured").
 */
export class FriendlyCloudError extends Error {
  constructor(public readonly friendly: FriendlyError) {
    super(friendly.title);
    this.name = 'FriendlyCloudError';
  }
}

/** One recognised error: a pattern, and how to explain it. */
export interface Rule {
  test: RegExp;
  build: (raw: string, match: RegExpMatchArray) => Omit<FriendlyError, 'raw'>;
}

/** Pull every bit of text out of an unknown thrown value (SDK errors vary a lot). */
export function errorText(error: unknown): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  const e = error as any;
  const parts = [
    e.code && typeof e.code === 'string' ? e.code : undefined, // AWS/Azure put the useful name here
    e.serviceCode,                                              // Oracle's error name
    e.message,
    e.details,
    e.reason,
    e.gcpCode,
    e.statusDetails && JSON.stringify(e.statusDetails),
  ];
  return parts.filter(Boolean).join(' | ') || String(error);
}

/**
 * Each cloud's rules, looked up WHEN NEEDED rather than copied into a table
 * when this file loads. The <cloud>/errors.ts files import from this file
 * too (a "circular import"); if a table were built at load time, whichever
 * file loaded first would see the other's rules as `undefined`, and every
 * error would become "Something went wrong". Reading them inside a function
 * avoids that, because by the time an error happens every file has loaded.
 */
function rulesFor(provider: string): Rule[] {
  switch (provider) {
    case 'gcp': return GCP_RULES || [];
    case 'aws': return AWS_RULES || [];
    case 'azure': return AZURE_RULES || [];
    case 'oracle': return ORACLE_RULES || [];
    default: return [];
  }
}

/** Problems that look the same on every cloud (network trouble). */
const COMMON_RULES: Rule[] = [
  {
    test: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|DEADLINE_EXCEEDED|timed? ?out/i,
    build: () => ({
      code: 'NETWORK',
      title: 'Couldn\'t reach the cloud provider',
      explanation: 'The backend didn\'t get an answer in time. This is usually temporary.',
      fixes: ['Try again in a minute.', 'If it keeps happening, check the status lights at the top of the page.'],
    }),
  },
];

/**
 * Convert anything that was thrown into a FriendlyError.
 * @param provider  which cloud the error came from ('gcp', 'aws', 'azure', 'oracle')
 * @param projectId GCP only: the user's project, so console links open on it
 */
export function toFriendlyError(error: unknown, provider = 'gcp', projectId?: string): FriendlyError {
  if (error instanceof FriendlyCloudError) return { ...error.friendly, cause: error.friendly.cause || causeOf(error.friendly.code) };
  if (provider === 'gcp') setGcpProjectContext(projectId);

  const raw = errorText(error);
  for (const rule of [...rulesFor(provider), ...COMMON_RULES]) {
    const match = raw.match(rule.test);
    if (match) {
      const built = rule.build(raw, match);
      return { ...built, raw, cause: causeOf(built.code) };
    }
  }

  return {
    code: 'UNKNOWN',
    title: 'Something went wrong',
    explanation: 'The cloud returned an error we don\'t have a plain-English explanation for yet. The original message is below.',
    fixes: [
      'Read the original message below — it often names the problem.',
      'Try again; some cloud errors are temporary.',
      'If it persists, send the operation id to whoever runs this app — the server logs have more detail.',
    ],
    raw,
    cause: 'other',
  };
}
