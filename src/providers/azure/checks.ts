/**
 * ============================================================================
 * src/providers/azure/checks.ts — "ADD MICROSOFT AZURE" FORM + LIVE CHECKS
 * ============================================================================
 *
 * Azure logins for programs are "service principals" (an app registration
 * plus a secret). The simplest way to make one with the right access is one
 * command in Azure Cloud Shell:
 *
 *   az ad sp create-for-rbac --name cloudgaming-hub --role Contributor \
 *       --scopes /subscriptions/<SUBSCRIPTION_ID>
 *
 * which prints appId (= Client ID), password (= Client secret) and
 * tenant (= Tenant ID).
 *
 * When someone submits the form, runChecks() goes through this list and
 * reports each result with a tip:
 *
 *   1. format       — do the four values look right? (GUIDs; secret isn't a Secret ID)
 *   2. signin       — does Microsoft Entra ID accept tenant + client ID + secret?
 *   3. subscription — can the app see the subscription, and is it enabled?
 *   4. plan         — is it a free-trial/student subscription (no GPUs)?
 *   5. permissions  — can the app read AND create resources (Contributor)?
 *   6. providers    — are Microsoft.Compute and Microsoft.Network registered?
 *   7. gpu-quota    — T4 GPU vCPU quota in the chosen region
 *   8. spot-quota   — Spot vCPU quota in the chosen region
 *
 * Checks 1–3 are FAILS (nothing is saved). The rest are WARNINGS (except a
 * clear lack of permissions): the login is fine and is saved, but launching
 * won't work until they're fixed — common while a quota request is pending.
 *
 * runChecks never throws for user mistakes; everything becomes a check.
 * The client secret is never logged and never put in `metadata`.
 * ============================================================================
 */

import { toFriendlyError } from '../errors';
import { AzureProvider, AzureCredentials } from '../AzureProvider';
import { PORTAL, CREATE_SP_COMMAND } from './errors';
import { CredentialCheck, ProviderSetupModule, outcome } from '../shared/types';
import { AZURE_SHAPES, DEFAULT_REGION, T4_QUOTA_FAMILY, findRegion } from './catalog';

/** The smallest machine we offer needs this many vCPUs of quota. */
const MIN_VCPUS = Math.min(...AZURE_SHAPES.map((s) => s.vcpus));

/** Actions a Contributor has and that launching needs. */
const NEEDED_ACTIONS = [
  'Microsoft.Resources/subscriptions/resourceGroups/write',
  'Microsoft.Network/publicIPAddresses/write',
  'Microsoft.Network/networkInterfaces/write',
  'Microsoft.Network/networkSecurityGroups/write',
  'Microsoft.Compute/virtualMachines/write',
  'Microsoft.Compute/snapshots/write',
];

/** Does an Azure permission pattern like "Microsoft.Compute/*" cover this action? */
function covers(pattern: string, action: string): boolean {
  const regex = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$', 'i');
  return regex.test(action);
}

function allowed(perms: Array<{ actions: string[]; notActions: string[] }>, action: string): boolean {
  return perms.some((p) => p.actions.some((a) => covers(a, action)) && !p.notActions.some((n) => covers(n, action)));
}

/** Turn any error into a failed/warning check with the friendly explanation. */
function checkFromError(id: string, label: string, status: 'fail' | 'warn', error: unknown): CredentialCheck {
  const f = toFriendlyError(error, 'azure');
  return { id, label, status, message: f.title, tip: f.fixes.join(' '), consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel };
}

export const AZURE_SETUP: ProviderSetupModule = {
  intro:
    'Add a service principal (a login for programs) with the "Contributor" role on your subscription. ' +
    `Quickest: open Azure Cloud Shell (the >_ icon at the top of portal.azure.com) and run: ${CREATE_SP_COMMAND} — ` +
    'it prints appId, password and tenant. Machines are created in YOUR subscription and billed to you by Microsoft.',
  fields: [
    {
      key: 'tenantId',
      label: 'Tenant ID (Directory ID)',
      type: 'text',
      required: true,
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      help: 'The "tenant" printed by az ad sp create-for-rbac — or Microsoft Entra ID → Overview → Tenant ID.',
    },
    {
      key: 'clientId',
      label: 'Client ID (Application ID)',
      type: 'text',
      required: true,
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      help: 'The "appId" printed by the command — or App registrations → your app → "Application (client) ID".',
    },
    {
      key: 'clientSecret',
      label: 'Client secret (value)',
      type: 'password',
      required: true,
      placeholder: 'abc8Q~…',
      help: 'The "password" printed by the command — or Certificates & secrets → the secret\'s VALUE (not its "Secret ID"). Shown only once.',
      secret: true,
    },
    {
      key: 'subscriptionId',
      label: 'Subscription ID',
      type: 'text',
      required: true,
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      help: 'Portal → Subscriptions → your subscription → "Subscription ID" (the GUID, not the name).',
    },
  ],

  async runChecks(input, opts) {
    const checks: CredentialCheck[] = [];
    const region = findRegion(opts.region || '')?.id || DEFAULT_REGION;

    // 1. Format
    let creds: AzureCredentials;
    try {
      creds = AzureProvider.parseCredentials(input);
      checks.push({ id: 'format', label: 'Value format', status: 'pass', message: 'Tenant, client and subscription IDs look right; a secret value was entered.' });
    } catch (error) {
      checks.push(checkFromError('format', 'Value format', 'fail', error));
      return outcome(checks, undefined, {});
    }

    // Non-secret facts for the UI. NEVER put the client secret here.
    const metadata: Record<string, unknown> = {
      tenantId: creds.tenantId,
      clientId: creds.clientId,
      subscriptionId: creds.subscriptionId,
      region,
    };
    const secret = { tenantId: creds.tenantId, clientId: creds.clientId, clientSecret: creds.clientSecret, subscriptionId: creds.subscriptionId };

    let provider: AzureProvider;
    try {
      provider = new AzureProvider(secret);
    } catch (error) {
      checks.push(checkFromError('format', 'Value format', 'fail', error));
      return outcome(checks, undefined, metadata);
    }

    // 2. Sign in (tenant + client ID + secret)
    try {
      await provider.signIn();
      checks.push({ id: 'signin', label: 'Sign in to Azure', status: 'pass', message: 'Microsoft Entra ID accepted the client ID and secret.' });
    } catch (error) {
      checks.push(checkFromError('signin', 'Sign in to Azure', 'fail', error));
      return outcome(checks, undefined, metadata);
    }

    // 3. Subscription visible and enabled
    let quotaId = '';
    try {
      const sub = await provider.getSubscription();
      metadata.subscriptionName = sub.displayName;
      quotaId = sub.quotaId || '';
      if (sub.state === 'Enabled') {
        checks.push({ id: 'subscription', label: 'Subscription', status: 'pass', message: `"${sub.displayName}" is active.` });
      } else if (sub.state === 'Warned' || sub.state === 'PastDue') {
        checks.push({
          id: 'subscription', label: 'Subscription', status: 'warn',
          message: `"${sub.displayName}" is in state "${sub.state}" — usually an overdue payment. Azure may disable it soon.`,
          tip: 'Check the payment method under Cost Management + Billing.',
          consoleUrl: PORTAL.subscriptions, consoleLabel: 'Open Subscriptions',
        });
      } else {
        checks.push({
          id: 'subscription', label: 'Subscription', status: 'fail',
          message: `"${sub.displayName}" is ${sub.state} — nothing can be created in it.`,
          tip: 'Re-enable it (or upgrade the free trial to Pay-As-You-Go) on the Subscriptions page, or use another subscription.',
          consoleUrl: PORTAL.subscriptions, consoleLabel: 'Open Subscriptions',
        });
        return outcome(checks, undefined, metadata);
      }
    } catch (error) {
      checks.push(checkFromError('subscription', 'Subscription', 'fail', error));
      return outcome(checks, undefined, metadata);
    }

    // 4. Plan: free trial / student subscriptions can't get GPU quota
    if (/^(FreeTrial|AzureForStudents|Students)/i.test(quotaId)) {
      checks.push({
        id: 'plan', label: 'Subscription type', status: 'warn',
        message: 'This is a free-trial or student subscription. Azure doesn\'t allow GPU machines on these, and the GPU quota can\'t be raised.',
        tip: 'Upgrade it to Pay-As-You-Go (Subscriptions → your subscription → Upgrade). Any remaining free credit is kept.',
        consoleUrl: PORTAL.subscriptions, consoleLabel: 'Open Subscriptions',
      });
    } else {
      checks.push({ id: 'plan', label: 'Subscription type', status: 'pass', message: quotaId ? `Offer: ${quotaId.replace(/_\d{4}-\d{2}-\d{2}$/, '')}` : 'Not a free trial.' });
    }

    // 5. Permissions: read, then (if Azure tells us) write
    try {
      await provider.listResourceGroupNames(1);
      let missing: string[] | undefined;
      try {
        const perms = await provider.getPermissions();
        missing = NEEDED_ACTIONS.filter((a) => !allowed(perms, a));
      } catch {
        missing = undefined; // couldn't list permissions — judged at first launch instead
      }
      if (missing === undefined) {
        checks.push({ id: 'permissions', label: 'Permissions', status: 'pass', message: 'The app can read your subscription. (Create rights are confirmed at the first launch.)' });
      } else if (missing.length === 0) {
        checks.push({ id: 'permissions', label: 'Permissions', status: 'pass', message: 'The app can create resource groups, networks, machines and snapshots (Contributor or equivalent).' });
      } else {
        checks.push({
          id: 'permissions', label: 'Permissions', status: 'fail',
          message: `The app can sign in but can't create what we need (missing: ${missing.join(', ')}).`,
          tip: `Give it the "Contributor" role on the subscription: Subscriptions → your subscription → Access control (IAM) → Add role assignment → Contributor → select the app. Or run: az role assignment create --assignee ${creds.clientId} --role Contributor --scope /subscriptions/${creds.subscriptionId}`,
          consoleUrl: PORTAL.subscriptions, consoleLabel: 'Open Subscriptions',
        });
      }
    } catch (error) {
      const f = toFriendlyError(error, 'azure');
      checks.push({
        id: 'permissions', label: 'Permissions', status: 'fail', message: f.title,
        tip: f.code === 'AZURE_PERMISSION' || f.code === 'AZURE_SUBSCRIPTION_NOT_FOUND'
          ? `Give the app the "Contributor" role on the subscription: az role assignment create --assignee ${creds.clientId} --role Contributor --scope /subscriptions/${creds.subscriptionId}`
          : f.fixes.join(' '),
        consoleUrl: f.consoleUrl || PORTAL.subscriptions, consoleLabel: f.consoleLabel || 'Open Subscriptions',
      });
    }

    // 6. Resource providers registered (we try to register them if not)
    try {
      const pending: string[] = [];
      const failed: string[] = [];
      for (const ns of ['Microsoft.Compute', 'Microsoft.Network']) {
        const state = await provider.getProviderState(ns);
        if (state === 'Registered') continue;
        try {
          if (state !== 'Registering') await provider.registerProvider(ns);
          pending.push(ns);
        } catch {
          failed.push(ns);
        }
      }
      if (!pending.length && !failed.length) {
        checks.push({ id: 'providers', label: 'Azure services enabled', status: 'pass', message: 'Microsoft.Compute and Microsoft.Network are registered.' });
      } else if (failed.length) {
        checks.push({
          id: 'providers', label: 'Azure services enabled', status: 'warn',
          message: `Not registered yet: ${[...failed, ...pending].join(', ')}. We couldn't register them automatically.`,
          tip: failed.map((ns) => `az provider register --namespace ${ns}`).join(' ; ') + ' — or Subscriptions → Resource providers → Register.',
          consoleUrl: PORTAL.subscriptions, consoleLabel: 'Open Subscriptions',
        });
      } else {
        checks.push({
          id: 'providers', label: 'Azure services enabled', status: 'warn',
          message: `Registering ${pending.join(' and ')} for your subscription now (one-time).`,
          tip: 'This finishes by itself in 1–5 minutes. Launching also waits for it.',
        });
      }
    } catch (error) {
      checks.push(checkFromError('providers', 'Azure services enabled', 'warn', error));
    }

    // 7 + 8. Quotas in the chosen region (Azure counts them in vCPUs)
    try {
      const usage = await provider.getComputeUsage(region);
      const find = (name: string) => usage.find((u) => u.name.toLowerCase() === name.toLowerCase());
      const free = (u?: { limit: number; current: number }) => (u ? u.limit - u.current : 0);
      const family = find(T4_QUOTA_FAMILY);
      const total = find('cores');
      const spot = find('lowPriorityCores');

      if (free(family) >= MIN_VCPUS && (!total || free(total) >= MIN_VCPUS)) {
        checks.push({
          id: 'gpu-quota', label: `GPU quota in ${region}`, status: 'pass',
          message: `T4 machines: ${free(family)} of ${family!.limit} vCPUs free (the smallest machine needs ${MIN_VCPUS}).`,
        });
      } else if (free(family) >= MIN_VCPUS) {
        checks.push({
          id: 'gpu-quota', label: `GPU quota in ${region}`, status: 'warn',
          message: `T4 quota is fine, but "Total Regional vCPUs" has only ${free(total)} free.`,
          tip: `On the Quotas page → Compute, filter ${region}, and request more "Total Regional vCPUs" (e.g. 16).`,
          consoleUrl: PORTAL.quotas, consoleLabel: 'Request quota',
        });
      } else {
        checks.push({
          id: 'gpu-quota', label: `GPU quota in ${region}`, status: 'warn',
          message: `No T4 GPU quota in ${region} yet (limit ${family?.limit ?? 0} vCPUs; need ${MIN_VCPUS}). Launching will fail until it's raised.`,
          tip: `Quotas page → Compute → filter region "${region}" and search "NCASv3_T4" ("Standard NCASv3_T4 Family vCPUs") → request 8. ` +
            'Small requests are often approved in minutes, otherwise within 1–2 business days. Free-trial subscriptions must upgrade first.',
          consoleUrl: PORTAL.quotas, consoleLabel: 'Request GPU quota',
        });
      }

      checks.push(free(spot) >= MIN_VCPUS
        ? { id: 'spot-quota', label: `Spot quota in ${region}`, status: 'pass', message: `Spot machines: ${free(spot)} vCPUs free.` }
        : {
            id: 'spot-quota', label: `Spot quota in ${region}`, status: 'warn',
            message: `No Spot vCPU quota in ${region} (${free(spot)} free) — cheaper spot machines won't launch; on-demand ones still can.`,
            tip: `Quotas page → Compute → filter "${region}" → "Total Regional Spot vCPUs" → request 8.`,
            consoleUrl: PORTAL.quotas, consoleLabel: 'Request quota',
          });
    } catch (error) {
      checks.push(checkFromError('gpu-quota', `GPU quota in ${region}`, 'warn', error));
    }

    return outcome(checks, secret, metadata);
  },
};
