/**
 * ============================================================================
 * src/providers/azure/errors.ts — TURN AZURE ERRORS INTO PLAIN ENGLISH
 * ============================================================================
 *
 * Azure errors come from two places, and both are cryptic:
 *
 *   1. SIGNING IN (Microsoft Entra ID, formerly "Azure Active Directory").
 *      These carry an "AADSTS" number, e.g.
 *        "AADSTS7000215: Invalid client secret provided."
 *   2. AZURE RESOURCE MANAGER ("ARM", the API that creates machines). These
 *      carry a short code, e.g. "AuthorizationFailed", "SkuNotAvailable",
 *      "OperationNotAllowed ... exceeding approved standardNCASv3_T4Family
 *      Cores quota".
 *
 * Each rule below recognises one of them and explains it as a FriendlyError
 * (title, meaning, numbered fixes, and a link to the right Azure portal
 * page). The shared machinery is in src/providers/errors.ts.
 *
 * ADDING A NEW CASE: add an entry to AZURE_RULES. Rules are checked top to
 * bottom and the first match wins, so specific rules go before general ones.
 * ============================================================================
 */

// TYPE-ONLY import on purpose: src/providers/errors.ts imports THIS file to
// build its rule table, so a runtime import back into it would be circular
// and, depending on which file Node loads first, AZURE_RULES could still be
// undefined when that table is built. Keeping this file free of runtime
// imports makes the load order irrelevant. (Import FriendlyCloudError and
// toFriendlyError from '../errors' directly.)
import type { Rule } from '../errors';

/** Handy Azure portal pages. */
export const PORTAL = {
  appRegistrations: 'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps',
  tenantProperties: 'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Properties',
  subscriptions: 'https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade',
  quotas: 'https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas',
  virtualMachines: 'https://portal.azure.com/#browse/Microsoft.Compute%2FVirtualMachines',
  resourceGroups: 'https://portal.azure.com/#browse/resourcegroups',
  policies: 'https://portal.azure.com/#view/Microsoft_Azure_Policy/PolicyMenuBlade/~/Assignments',
};

/** The command that creates the right kind of login for this app (shown in several tips). */
export const CREATE_SP_COMMAND =
  'az ad sp create-for-rbac --name cloudgaming-hub --role Contributor --scopes /subscriptions/<SUBSCRIPTION_ID>';

export const AZURE_RULES: Rule[] = [
  // ---- Signing in (Microsoft Entra ID "AADSTS" errors) --------------------
  {
    test: /AADSTS7000215/i,
    build: () => ({
      code: 'AZURE_SECRET_INVALID',
      title: 'Azure rejected the client secret',
      explanation:
        'The client secret doesn\'t match the app. The most common cause is pasting the secret\'s ID (which looks like ' +
        'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) instead of its VALUE (a ~40-character string that is only shown once, right after it\'s created).',
      fixes: [
        'Open App registrations (button below) → your app (e.g. "cloudgaming-hub") → Certificates & secrets.',
        'Click "New client secret", then IMMEDIATELY copy the "Value" column (not "Secret ID").',
        `Or, in Azure Cloud Shell, run: az ad sp credential reset --id <CLIENT_ID> — it prints a new "password"; that's the secret.`,
        'Paste the new value on the Config page here.',
      ],
      consoleUrl: PORTAL.appRegistrations,
      consoleLabel: 'Open App registrations',
    }),
  },
  {
    test: /AADSTS7000222/i,
    build: () => ({
      code: 'AZURE_SECRET_EXPIRED',
      title: 'The client secret has expired',
      explanation: 'Azure client secrets have an end date (often 1 year). This one is past it, so Azure no longer accepts it.',
      fixes: [
        'Open App registrations (button below) → your app → Certificates & secrets → "New client secret".',
        'Copy the new secret\'s Value and paste it on the Config page here.',
        'Or run in Azure Cloud Shell: az ad sp credential reset --id <CLIENT_ID> (the "password" it prints is the new secret).',
      ],
      consoleUrl: PORTAL.appRegistrations,
      consoleLabel: 'Open App registrations',
    }),
  },
  {
    test: /AADSTS700016/i,
    build: () => ({
      code: 'AZURE_APP_NOT_FOUND',
      title: 'Azure can\'t find that app (client ID) in this directory',
      explanation:
        'Either the Client ID is wrong, or the app lives in a different Microsoft Entra directory (tenant) than the Tenant ID you entered, or it was deleted.',
      fixes: [
        'Open App registrations (button below) → "All applications" and find your app.',
        'Copy its "Application (client) ID" into Client ID, and its "Directory (tenant) ID" into Tenant ID.',
        'If it isn\'t there, create one with: ' + CREATE_SP_COMMAND,
      ],
      consoleUrl: PORTAL.appRegistrations,
      consoleLabel: 'Open App registrations',
    }),
  },
  {
    test: /AADSTS90002|AADSTS900023|AADSTS90013|Tenant '.*' not found/i,
    build: () => ({
      code: 'AZURE_TENANT_NOT_FOUND',
      title: 'Azure doesn\'t recognise that Tenant ID',
      explanation: 'The Tenant ID (your Microsoft Entra directory\'s ID) is wrong or mistyped.',
      fixes: [
        'Open Microsoft Entra ID → Overview/Properties (button below) and copy "Tenant ID".',
        'It\'s also the "tenant" value printed by az ad sp create-for-rbac.',
      ],
      consoleUrl: PORTAL.tenantProperties,
      consoleLabel: 'Open tenant properties',
    }),
  },
  {
    test: /AADSTS\d+/i,
    build: (raw) => ({
      code: 'AZURE_SIGNIN',
      title: 'Azure refused the sign-in',
      explanation: `Microsoft Entra ID returned ${raw.match(/AADSTS\d+/i)?.[0]}. The original message below says why.`,
      fixes: [
        'Check Tenant ID, Client ID and Client secret on the Config page — all three must come from the same app.',
        'If unsure, create a fresh login with: ' + CREATE_SP_COMMAND,
      ],
      consoleUrl: PORTAL.appRegistrations,
      consoleLabel: 'Open App registrations',
    }),
  },

  // ---- Subscription problems ----------------------------------------------
  {
    test: /ReadOnlyDisabledSubscription|SubscriptionDisabled|subscription (is|has been) disabled|DisabledSubscription/i,
    build: () => ({
      code: 'AZURE_SUBSCRIPTION_DISABLED',
      title: 'Your Azure subscription is disabled (read-only)',
      explanation:
        'Azure has switched the subscription to read-only — usually because a free trial or credit ran out, or a payment failed. Nothing can be created until it\'s re-enabled.',
      fixes: [
        'Open Subscriptions (button below) and check its status.',
        'If it was a free trial, click "Upgrade" to switch to Pay-As-You-Go.',
        'If a payment failed, update the payment method under Cost Management + Billing.',
      ],
      consoleUrl: PORTAL.subscriptions,
      consoleLabel: 'Open Subscriptions',
    }),
  },
  {
    test: /SubscriptionNotFound|InvalidSubscriptionId|subscription .* (could not be found|was not found)/i,
    build: () => ({
      code: 'AZURE_SUBSCRIPTION_NOT_FOUND',
      title: 'Azure can\'t find that subscription (or the app can\'t see it)',
      explanation:
        'Either the Subscription ID is wrong, or the app you entered hasn\'t been given any role on that subscription — Azure hides subscriptions you have no access to.',
      fixes: [
        'Open Subscriptions (button below) and copy the "Subscription ID" (a GUID, not the name).',
        'Make sure the app has the Contributor role on it: Subscription → Access control (IAM) → Add role assignment → Contributor → select your app.',
        'Or recreate the login with the right scope: ' + CREATE_SP_COMMAND,
      ],
      consoleUrl: PORTAL.subscriptions,
      consoleLabel: 'Open Subscriptions',
    }),
  },
  {
    test: /MissingSubscriptionRegistration|not registered to use namespace '?([A-Za-z.]+)'?/i,
    build: (raw) => {
      const ns = raw.match(/namespace '?([A-Za-z]+\.[A-Za-z]+)'?/i)?.[1] || 'Microsoft.Compute';
      return {
        code: 'AZURE_RP_NOT_REGISTERED',
        title: `Your subscription hasn't switched on "${ns}" yet`,
        explanation:
          'Azure subscriptions must "register" each service (resource provider) before first use. New subscriptions often haven\'t registered Compute or Network yet.',
        fixes: [
          `In Azure Cloud Shell run: az provider register --namespace ${ns}`,
          'Or: Subscriptions (button below) → your subscription → Resource providers → search the name → Register.',
          'It takes 1–5 minutes; then try again.',
        ],
        consoleUrl: PORTAL.subscriptions,
        consoleLabel: 'Open Subscriptions',
      };
    },
  },

  // ---- Permissions / policy ------------------------------------------------
  {
    test: /AuthorizationFailed|LinkedAuthorizationFailed|does not have authorization to perform action/i,
    build: (raw) => {
      const action = raw.match(/perform action '([^']+)'/i)?.[1];
      return {
        code: 'AZURE_PERMISSION',
        title: action ? `The app isn't allowed to do "${action}"` : 'The app isn\'t allowed to do that in your subscription',
        explanation:
          'Signing in worked, but the app (service principal) doesn\'t have a role that allows creating machines. It needs the "Contributor" role on the subscription.',
        fixes: [
          'Open Subscriptions (button below) → your subscription → Access control (IAM) → Add → Add role assignment.',
          'Choose "Contributor" (under "Privileged administrator roles"), then Members → Select members → search for your app\'s name → Review + assign.',
          'Or in Azure Cloud Shell: az role assignment create --assignee <CLIENT_ID> --role Contributor --scope /subscriptions/<SUBSCRIPTION_ID>',
          'Role changes can take up to 5 minutes to apply.',
        ],
        consoleUrl: PORTAL.subscriptions,
        consoleLabel: 'Open Subscriptions',
      };
    },
  },
  {
    test: /RequestDisallowedByPolicy/i,
    build: (raw) => ({
      code: 'AZURE_POLICY',
      title: 'An Azure Policy in your organisation blocks this',
      explanation:
        'Your subscription has a policy assignment that forbids this kind of resource (for example public IP addresses, GPU sizes or certain regions).' +
        (raw.match(/policy '([^']+)'/i)?.[1] ? ` Policy: ${raw.match(/policy '([^']+)'/i)?.[1]}.` : ''),
      fixes: [
        'Open Policy → Assignments (button below) to see which policy blocked it.',
        'Ask whoever manages your Azure organisation for an exemption, or use a personal subscription.',
      ],
      consoleUrl: PORTAL.policies,
      consoleLabel: 'Open Policy assignments',
    }),
  },

  // ---- Free trial / subscription type --------------------------------------
  {
    test: /free ?trial|FreeTrial|Azure for Students|not (available|supported) for (your|this) (subscription|offer)|subscription (type|offer) .*not (supported|allowed)/i,
    build: () => ({
      code: 'AZURE_FREE_TRIAL',
      title: 'Free-trial Azure subscriptions can\'t use GPU machines',
      explanation:
        'Azure free trial, student and some sponsored subscriptions have a GPU limit of 0 that can\'t be raised.',
      fixes: [
        'Open Subscriptions (button below), pick the subscription and click "Upgrade" to Pay-As-You-Go (your remaining free credit is kept).',
        'Then request GPU quota (see the quota error if it appears next).',
      ],
      consoleUrl: PORTAL.subscriptions,
      consoleLabel: 'Open Subscriptions',
    }),
  },

  // ---- Quotas (Azure counts quota in vCPUs, not GPUs) -----------------------
  {
    test: /LowPriorityCores|low ?priority.*quota|spot.*quota/i,
    build: (raw) => ({
      code: 'AZURE_SPOT_QUOTA',
      title: 'No Spot VM quota in this region',
      explanation:
        'Spot machines use a separate limit, "Total Regional Spot vCPUs", which is often 0 on new subscriptions. Azure counts quota in vCPUs (a 4-vCPU machine needs 4).' +
        (raw.match(/Current Limit: (\d+)/i) ? ` Current limit: ${raw.match(/Current Limit: (\d+)/i)?.[1]}.` : ''),
      fixes: [
        'Launch without spot (on-demand) instead, or',
        'Open Quotas (button below) → Compute → filter your region → "Total Regional Spot vCPUs" → request 8 or more.',
      ],
      consoleUrl: PORTAL.quotas,
      consoleLabel: 'Request quota',
    }),
  },
  {
    test: /NCASv3_T4\w*.*quota|quota.*NCASv3_T4/i,
    build: (raw) => ({
      code: 'AZURE_GPU_QUOTA',
      title: 'Your subscription isn\'t allowed T4 GPU machines in this region yet',
      explanation:
        'New subscriptions start with 0 quota for GPU machine families. Azure counts it in vCPUs: the smallest T4 machine needs 4, the 8-vCPU one needs 8.' +
        (raw.match(/Current Limit: (\d+)/i) ? ` Current limit: ${raw.match(/Current Limit: (\d+)/i)?.[1]}.` : ''),
      fixes: [
        'Open Quotas (button below) → Compute.',
        'Filter by your region and search "NCASv3_T4" ("Standard NCASv3_T4 Family vCPUs").',
        'Tick it, click the pencil / "New quota request", ask for 8 (enough for either size) and submit.',
        'Small requests are often approved in minutes; otherwise a support ticket opens automatically (can take 1–2 business days).',
        'Free-trial subscriptions must be upgraded to Pay-As-You-Go first.',
      ],
      consoleUrl: PORTAL.quotas,
      consoleLabel: 'Request GPU quota',
    }),
  },
  {
    test: /QuotaExceeded|exceeding (the )?approved .* quota|quota .* exceeded|OperationNotAllowed.*quota/i,
    build: (raw) => {
      const what = raw.match(/approved ([A-Za-z0-9_ ]+?) quota/i)?.[1];
      return {
        code: 'AZURE_QUOTA',
        title: what ? `Azure quota "${what}" is used up` : 'An Azure quota is used up',
        explanation:
          'Your subscription has hit one of its limits in this region (often "Total Regional vCPUs", or public IP addresses).',
        fixes: [
          'Delete machines you no longer need, or',
          `Open Quotas (button below) → Compute, filter by your region${what ? ` and "${what}"` : ''}, and request more.`,
        ],
        consoleUrl: PORTAL.quotas,
        consoleLabel: 'Open Quotas',
      };
    },
  },

  // ---- Capacity (Azure has no spare machines of this size right now) --------
  {
    test: /SkuNotAvailable|NotAvailableForSubscription/i,
    build: () => ({
      code: 'AZURE_SKU_NOT_AVAILABLE',
      title: 'This machine size isn\'t available to you in this region',
      explanation:
        'Azure says this GPU size is currently restricted in this region — either it\'s sold out, or Azure hasn\'t enabled it for your subscription here.',
      fixes: [
        'Try another region (Southeast Asia, Japan East, East US, West Europe...).',
        'For spot machines, try on-demand instead.',
        'If it persists in a region you need, open a support request: "Service and subscription limits (quotas)" → "Compute-VM" → region/SKU access.',
      ],
      consoleUrl: PORTAL.quotas,
      consoleLabel: 'Open Quotas',
    }),
  },
  {
    test: /AllocationFailed|ZonalAllocationFailed|OverconstrainedAllocationRequest|OverconstrainedZonalAllocationRequest|AllocationTimedOut|insufficient capacity/i,
    build: () => ({
      code: 'AZURE_CAPACITY',
      title: 'Azure is out of these GPU machines here right now',
      explanation:
        'This isn\'t a problem with your account — Azure temporarily has no spare machines of this size in this region. It usually clears within minutes to hours.',
      fixes: [
        'Try again in a few minutes.',
        'Or pick another region or machine size.',
        'Spot machines are the first to run out — switching spot off can help.',
        'Starting a stopped machine can hit this too (a stopped Azure machine gives its hardware back); just try again later.',
      ],
    }),
  },

  // ---- Something else is happening to the resource --------------------------
  {
    test: /AnotherOperationInProgress|OperationPreempted|Conflict|ResourceGroupBeingDeleted|InUse|is in use|PropertyChangeNotAllowed|OperationNotAllowed/i,
    build: () => ({
      code: 'AZURE_BUSY',
      title: 'Azure is still busy with this machine',
      explanation:
        'Another operation (starting, stopping, deleting, or a spot eviction) is still running on this machine or one of its parts, so Azure refused this one.',
      fixes: [
        'Wait a minute, press "Sync" to refresh the machine\'s state, then try again.',
      ],
      consoleUrl: PORTAL.virtualMachines,
      consoleLabel: 'Open Virtual machines',
    }),
  },

  // ---- Invalid requests -------------------------------------------------------
  {
    test: /InvalidTemplateDeployment|InvalidParameter|InvalidRequestFormat|BadRequest/i,
    build: () => ({
      code: 'AZURE_INVALID_REQUEST',
      title: 'Azure rejected the machine settings',
      explanation:
        'Azure said one of the settings we sent isn\'t valid here (for example the disk size, image or machine size in this region). The original message below names the setting.',
      fixes: [
        'Try a different region or machine size.',
        'If the message mentions the disk, try a disk size between 64 and 1024 GB.',
        'If it keeps happening, send the operation id to whoever runs this app.',
      ],
    }),
  },

  // ---- Missing things ----------------------------------------------------------
  {
    test: /ResourceNotFound|ResourceGroupNotFound|NotFound|was not found|404/i,
    build: () => ({
      code: 'AZURE_NOT_FOUND',
      title: 'Azure couldn\'t find that resource',
      explanation:
        'The machine, disk or snapshot no longer exists in Azure — it may have been deleted in the portal (or its resource group was).',
      fixes: ['Press "Sync" to refresh the machine\'s real state.', 'If it\'s gone, delete it here to clean up the record.'],
      consoleUrl: PORTAL.virtualMachines,
      consoleLabel: 'Open Virtual machines',
    }),
  },
];

/** Is this Azure's "doesn't exist" answer? */
export function isAzureNotFound(error: unknown): boolean {
  const e = error as any;
  const text = [typeof e?.code === 'string' ? e.code : '', e?.message, typeof error === 'string' ? error : ''].filter(Boolean).join(' | ');
  // A missing SUBSCRIPTION is a credentials problem, not "the machine is gone".
  if (/SubscriptionNotFound/i.test(text)) return false;
  if ((error as any)?.statusCode === 404) return true;
  return /ResourceNotFound|ResourceGroupNotFound|\bNotFound\b|was not found/i.test(text);
}
