/**
 * ============================================================================
 * src/providers/oracle/errors.ts — TURN ORACLE CLOUD (OCI) ERRORS INTO PLAIN ENGLISH
 * ============================================================================
 *
 * Oracle's errors come back from the SDK as an `OciError` with three useful
 * parts (errorText() in ../errors.ts glues them together for us):
 *   - statusCode   the HTTP status, e.g. 401, 404, 500
 *   - serviceCode  Oracle's short error name, e.g. "NotAuthorizedOrNotFound"
 *   - message      a sentence, e.g. "Out of host capacity."
 *
 * The famous confusing one is NotAuthorizedOrNotFound (404): for security,
 * Oracle deliberately refuses to say whether a thing doesn't exist or you're
 * simply not ALLOWED to see it. Nine times out of ten on a new account it's
 * a missing IAM policy, so our card explains both and gives the exact policy
 * lines to paste.
 *
 * This file only holds Oracle's rules (import FriendlyCloudError and
 * toFriendlyError from ../errors). The shared machinery (FriendlyError,
 * toFriendlyError, errorText) lives in src/providers/errors.ts, which already
 * registers ORACLE_RULES.
 *
 * ADDING A NEW CASE: add an entry to ORACLE_RULES. Rules are checked top to
 * bottom and the FIRST match wins, so specific rules go before general ones.
 * ============================================================================
 */

// TYPE-ONLY import on purpose: ../errors imports THIS file (to register
// ORACLE_RULES), so a normal import here would make a circular load. If this
// file happened to load first, ORACLE_RULES would still be undefined when
// ../errors reads it, and every Oracle error would lose its explanation.
// Type imports vanish when compiled, so there's no cycle at runtime.
import type { Rule } from '../errors';

/** All the text in an error (loaded lazily for the same circular-import reason). */
function errorText(error: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require('../errors') as typeof import('../errors');
  return shared.errorText(error);
}

/** A link into the Oracle Cloud console, e.g. oracleConsole('limits'). */
export function oracleConsole(path = ''): string {
  return `https://cloud.oracle.com/${path}`;
}

/**
 * The IAM policy statements a group needs so CloudGaming Hub can do its job.
 * `scope` is "tenancy" or "compartment <name>". Shown in error cards and in
 * the credential checks so the user can copy-paste them.
 */
export function oraclePolicyStatements(group = 'CloudGaming', scope = 'tenancy'): string[] {
  return [
    `Allow group ${group} to manage instance-family in ${scope}`,
    `Allow group ${group} to manage virtual-network-family in ${scope}`,
    `Allow group ${group} to manage volume-family in ${scope}`,
    `Allow group ${group} to read all-resources in ${scope}`,
  ];
}

const CAPACITY_RE = /Out of host capacity|OutOfCapacity|out of capacity|insufficient capacity/i;

export const ORACLE_RULES: Rule[] = [
  // ---- The private key itself is unusable (fails before any request is sent)
  {
    test: /bad decrypt|passphrase|encrypted private key|Unsupported key|DECODER routines|PEM routines|no start line|Invalid private key/i,
    build: () => ({
      code: 'OCI_PRIVATE_KEY',
      title: 'The Oracle API private key can\'t be read',
      explanation:
        'The backend signs every request to Oracle with your API private key (.pem). This key is damaged, is the PUBLIC key by mistake, or needs a different passphrase.',
      fixes: [
        'Use the PRIVATE key file you downloaded when adding the API key (the one whose name ends in ".pem" but NOT "_public.pem").',
        'It must start with "-----BEGIN PRIVATE KEY-----" or "-----BEGIN RSA PRIVATE KEY-----" — not "BEGIN PUBLIC KEY".',
        'If you protected the key with a passphrase, enter it in the Passphrase field; if not, leave that field empty.',
        'Lost the private key? Add a new API key in the Oracle console (Profile → My profile → API keys → Add API key) and use the new files.',
      ],
      consoleUrl: oracleConsole('identity/domains/my-profile/api-keys'),
      consoleLabel: 'Open API keys',
    }),
  },

  // ---- Region not subscribed ----------------------------------------------
  {
    test: /not subscribed|TenancyNotSubscribed|RegionNotSubscribed|isn't subscribed to region|not been subscribed/i,
    build: () => ({
      code: 'OCI_REGION_NOT_SUBSCRIBED',
      title: 'Your Oracle tenancy isn\'t subscribed to this region',
      explanation:
        'Oracle accounts only work in regions they have subscribed to. New accounts have just their home region.',
      fixes: [
        'In the Oracle console, open the region menu (top bar) → "Manage regions".',
        'Find the region you want (e.g. Singapore, ap-singapore-1) and click "Subscribe". It takes a few minutes.',
        'Or pick a region your tenancy already uses. Free-trial accounts may be limited to their home region.',
      ],
      consoleUrl: oracleConsole('regions/infrastructure'),
      consoleLabel: 'Manage regions',
    }),
  },

  // ---- Credentials rejected (401) -------------------------------------------
  {
    test: /NotAuthenticated|\b401\b|required information to complete authentication/i,
    build: () => ({
      code: 'OCI_NOT_AUTHENTICATED',
      title: 'Oracle didn\'t accept these API credentials',
      explanation:
        'Oracle couldn\'t match the signature on our request to an API key. Usually the fingerprint, user OCID or tenancy OCID doesn\'t belong with the private key.',
      fixes: [
        'In the Oracle console: Profile (top right) → My profile → API keys. Check the fingerprint listed there matches the one you entered, character for character.',
        'Check the User OCID is YOUR user (starts with ocid1.user.) and the Tenancy OCID starts with ocid1.tenancy. — copy both from the "Configuration file preview" shown when the key was added.',
        'Make sure you uploaded the PRIVATE key that matches that fingerprint (every new key pair has a new fingerprint).',
        'Newly added keys can take a minute to work. Also check this server\'s clock is correct — Oracle rejects requests more than 5 minutes off.',
        'Oracle also answers like this when the region isn\'t one your tenancy is subscribed to — try your home region.',
      ],
      consoleUrl: oracleConsole('identity/domains/my-profile/api-keys'),
      consoleLabel: 'Open API keys',
    }),
  },

  // ---- Capacity (must come before the generic InternalError / 500 rule) ----
  {
    test: CAPACITY_RE,
    build: () => ({
      code: 'OCI_OUT_OF_CAPACITY',
      title: 'Oracle has no spare GPU machines of this shape right now',
      explanation:
        'This isn\'t a problem with your account — Oracle temporarily has no free hardware for this GPU shape in the availability domain(s) we tried. It usually clears within minutes to hours.',
      fixes: [
        'Try again in a few minutes.',
        'Or pick another region (Oracle charges the same price in every region).',
        'Preemptible machines are the first to run out; switching Preemptible off can help.',
      ],
    }),
  },

  // ---- Service limits / compartment quotas ----------------------------------
  {
    test: /LimitExceeded|QuotaExceeded|service limit|limit.*exceeded|exceeded.*(limit|quota)/i,
    build: (raw) => {
      const quota = /QuotaExceeded|compartment quota/i.test(raw);
      if (quota) {
        return {
          code: 'OCI_COMPARTMENT_QUOTA',
          title: 'A compartment quota blocks this',
          explanation: 'An administrator set a quota policy on this compartment that doesn\'t allow this many of this resource.',
          fixes: [
            'Ask your Oracle administrator to raise or remove the quota (Governance → Quota policies).',
            'Or use a different compartment.',
          ],
          consoleUrl: oracleConsole('quotas'),
          consoleLabel: 'Open Quota policies',
        };
      }
      return {
        code: 'OCI_SERVICE_LIMIT',
        title: 'Your Oracle account isn\'t allowed this GPU yet (service limit)',
        explanation:
          'New Oracle accounts have a limit of 0 for every GPU shape. Limits are per GPU type and per availability domain, and must be raised before you can launch.',
        fixes: [
          'Open Governance → Limits, Quotas and Usage (button below). Choose Service "Compute" and your region.',
          'Search for the GPU (e.g. "GPUs for GPU.A10 based VM and BM instances"). Preemptible machines may need the separate preemptible limit.',
          'Click "Request a service limit increase", ask for 1 in the availability domain you want and give a short reason like "cloud gaming".',
          'Free-trial / "Always Free" accounts must upgrade to Pay As You Go first — GPUs are never part of the free tier.',
          'Approval usually takes from a few hours to a couple of business days.',
        ],
        consoleUrl: oracleConsole('limits'),
        consoleLabel: 'Open Limits',
      };
    },
  },

  // ---- Too many requests ---------------------------------------------------
  {
    test: /TooManyRequests|\b429\b|rate limit/i,
    build: () => ({
      code: 'OCI_TOO_MANY_REQUESTS',
      title: 'Oracle asked us to slow down',
      explanation: 'Too many API calls were made in a short time (from this app or anything else using your account).',
      fixes: ['Wait a minute and try again.'],
    }),
  },

  // ---- Shape / image mismatch ------------------------------------------------
  {
    test: /InvalidParameter.*(shape|image)|shape .*(not valid|not compatible|is not supported|incompatible)|image .*(not compatible|not supported).*shape/i,
    build: () => ({
      code: 'OCI_SHAPE_IMAGE_MISMATCH',
      title: 'That machine shape can\'t use this disk image',
      explanation:
        'Oracle rejected the combination of GPU shape and operating-system image (for example an ARM image on an x86 GPU shape), or the shape isn\'t offered in this region.',
      fixes: [
        'Try again — we pick the newest Ubuntu 22.04 image that Oracle lists as compatible with the shape.',
        'If it keeps happening, pick a different GPU shape or region.',
      ],
    }),
  },

  // ---- Malformed request -------------------------------------------------------
  {
    test: /CannotParseRequest|InvalidParameter|MissingParameter/i,
    build: () => ({
      code: 'OCI_BAD_REQUEST',
      title: 'Oracle rejected the request as invalid',
      explanation:
        'Something in the request didn\'t match what Oracle expects — often an OCID pasted with extra spaces, or an OCID from a different region or tenancy.',
      fixes: [
        'Check the Tenancy, User and Compartment OCIDs on the Config page have no spaces or line breaks and start with "ocid1.".',
        'If this happened on a machine or snapshot action, press "Sync" and try again.',
        'The original message below names the field Oracle didn\'t like.',
      ],
    }),
  },

  // ---- 404: Oracle's deliberately vague "not found OR not allowed" -----------
  {
    test: /NotAuthorizedOrNotFound|NotAuthorized|\b404\b|Authorization failed or requested resource not found/i,
    build: () => ({
      code: 'OCI_NOT_AUTHORIZED_OR_NOT_FOUND',
      title: 'Oracle says "not authorised, or not found"',
      explanation:
        'Oracle uses one error for both "this doesn\'t exist" and "you aren\'t allowed to see it". On a new setup it almost always means the API user\'s group is missing an IAM policy. On an existing machine it can mean it was deleted in the console.',
      fixes: [
        'In the Oracle console open Identity & Security → Policies (in the ROOT compartment) and create a policy with these statements (replace CloudGaming with your group\'s name; write "in compartment <name>" instead of "in tenancy" to limit it to one compartment):',
        ...oraclePolicyStatements(),
        'Make sure the API user is a member of that group (Identity → Domains → Default → Groups).',
        'If you entered a Compartment OCID, check it is correct and in the same tenancy.',
        'If this was about an existing machine or snapshot, it may have been deleted — press "Sync" to refresh.',
      ],
      consoleUrl: oracleConsole('identity/domains/policies'),
      consoleLabel: 'Open Policies',
    }),
  },

  // ---- Couldn't reach Oracle at all --------------------------------------------
  {
    test: /fetch failed|ECONNREFUSED|ENOTFOUND|getaddrinfo|certificate/i,
    build: () => ({
      code: 'NETWORK',
      title: 'Couldn\'t reach Oracle Cloud',
      explanation: 'The backend couldn\'t connect to Oracle\'s API. Usually temporary — or the region id is misspelt, so its address doesn\'t exist.',
      fixes: [
        'Check the region id (e.g. ap-singapore-1) is spelt correctly.',
        'Try again in a minute. If it keeps happening, check https://ocistatus.oraclecloud.com.',
      ],
    }),
  },

  // ---- Oracle-side hiccup ------------------------------------------------------
  {
    test: /InternalError|InternalServerError|ServiceUnavailable|\b50[023]\b/i,
    build: () => ({
      code: 'OCI_INTERNAL',
      title: 'Oracle Cloud had an internal error',
      explanation: 'Oracle\'s side failed while handling the request. This is usually temporary.',
      fixes: ['Try again in a minute or two.', 'Check https://ocistatus.oraclecloud.com if it keeps happening.'],
    }),
  },
];

/**
 * Is this Oracle saying "no spare hardware right now"? (LaunchInstance
 * returns it as a 500 InternalError "Out of host capacity.") Trying another
 * availability domain, or waiting, can help.
 */
export function isOracleCapacityError(error: unknown): boolean {
  return CAPACITY_RE.test(errorText(error));
}

/**
 * Is this a problem where trying ANOTHER AVAILABILITY DOMAIN might work?
 * Oracle's GPU service limits are counted PER availability domain, so a
 * LimitExceeded in AD-1 can still succeed in AD-2 — as can a capacity error
 * or "this shape isn't offered in this AD". Credential, permission and
 * compartment-quota errors are not: they'd fail the same everywhere.
 */
export function isOracleAdSpecificError(error: unknown): boolean {
  const raw = errorText(error);
  if (/NotAuthenticated|NotAuthorized|CannotParseRequest|private key|passphrase/i.test(raw)) return false;
  if (/QuotaExceeded|compartment quota/i.test(raw)) return false;
  return isOracleCapacityError(error)
    || /LimitExceeded|service limit/i.test(raw)
    || /shape .*(not available|not found|not supported) in (this |the )?availability domain/i.test(raw);
}
