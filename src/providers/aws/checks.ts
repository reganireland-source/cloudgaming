/**
 * ============================================================================
 * src/providers/aws/checks.ts — "ADD AWS" FORM + LIVE CHECKS
 * ============================================================================
 *
 * When someone adds AWS credentials on the Config page, runChecks() goes
 * through this list and reports each result with a tip:
 *
 *   1. format      — do the key ID and secret look like AWS keys?
 *   2. signin      — does AWS accept the key? (STS GetCallerIdentity — a
 *                    call every valid key may make, no permissions needed)
 *   3. permissions — WOULD EC2 let this key launch a g4dn.xlarge? We ask
 *                    with DryRun, so nothing is created or billed.
 *   4. gpu-quota   — on-demand "G and VT" vCPU quota ≥ 4 in the region?
 *   5. spot-quota  — same for spot instances (only matters if you use spot)
 *   6. network     — does the region have a default VPC?
 *
 * 1–3 are FAILS (nothing is saved) — except odd-looking formats, which only
 * warn. 4–6 are WARNINGS: the key is fine and is saved, but launching won't
 * work until they're fixed — common while a quota request is pending.
 *
 * runChecks must NEVER throw for user mistakes: every problem becomes a
 * check with a tip. The secret is never put in messages or metadata.
 * ============================================================================
 */

import { AWSProvider } from '../AWSProvider';
import { toFriendlyError } from '../errors';
import { CredentialCheck, ProviderSetupModule, outcome } from '../shared/types';
import { AWS_CONSOLE, AWS_REQUIRED_PERMISSIONS } from './errors';
import { DEFAULT_REGION, findRegion } from './catalog';

/** Service Quotas codes for EC2 GPU machines (vCPUs, per region). */
const QUOTA_ON_DEMAND_G = 'L-DB2E81BA'; // Running On-Demand G and VT instances
const QUOTA_SPOT_G = 'L-3819A6DF';      // All G and VT Spot Instance Requests
const MIN_VCPUS = 4;                    // one g4dn.xlarge / g5.xlarge

/** A console link opened on a specific region (AWS uses a region subdomain). */
function regional(url: string, region: string): string {
  return url.replace('https://console.aws.amazon.com/', `https://${region}.console.aws.amazon.com/`);
}

export const AWS_SETUP: ProviderSetupModule = {
  intro:
    'Paste an access key for an IAM user with the "AmazonEC2FullAccess" policy. Machines are created in YOUR AWS account and billed to you by Amazon.',
  fields: [
    {
      key: 'accessKeyId',
      label: 'Access key ID',
      type: 'text',
      required: true,
      placeholder: 'AKIAIOSFODNN7EXAMPLE',
      help: 'IAM → Users → your user → Security credentials → Create access key. Starts with "AKIA", 20 characters.',
    },
    {
      key: 'secretAccessKey',
      label: 'Secret access key',
      type: 'password',
      required: true,
      placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      help: 'Shown only once, right after you create the key (40 characters). Lost it? Create a new key.',
      secret: true,
    },
  ],

  async runChecks(input, opts) {
    const checks: CredentialCheck[] = [];
    const region = findRegion(opts.region || '')?.id || DEFAULT_REGION;

    // Remove spaces/newlines picked up while copying.
    const accessKeyId = String(input.accessKeyId || '').replace(/\s+/g, '');
    const secretAccessKey = String(input.secretAccessKey || '').replace(/\s+/g, '');

    // 1. Format --------------------------------------------------------------
    if (!accessKeyId || !secretAccessKey) {
      checks.push({
        id: 'format', label: 'Key format', status: 'fail',
        message: !accessKeyId ? 'The access key ID is empty.' : 'The secret access key is empty.',
        tip: 'Both values are needed. IAM → Users → your user → Security credentials → Create access key → "Application running outside AWS".',
        consoleUrl: AWS_CONSOLE.iamUsers, consoleLabel: 'Open IAM users',
      });
      return outcome(checks, undefined, {});
    }
    const idLooksRight = /^(AKIA|ASIA)[A-Z0-9]{16}$/.test(accessKeyId);
    const secretLooksRight = /^[A-Za-z0-9/+]{40}$/.test(secretAccessKey);
    if (idLooksRight && secretLooksRight) {
      checks.push({ id: 'format', label: 'Key format', status: 'pass', message: `Access key ${accessKeyId.slice(0, 8)}… looks like an AWS key.` });
    } else {
      checks.push({
        id: 'format', label: 'Key format', status: 'warn',
        message: !idLooksRight
          ? 'The access key ID doesn\'t look usual (expected "AKIA" + 16 capital letters/digits).'
          : 'The secret access key doesn\'t look usual (expected 40 characters).',
        tip: 'Check nothing was cut off or swapped (the ID is the short one, the secret the long one). We\'ll still try it.',
      });
    }
    if (accessKeyId.startsWith('ASIA')) {
      checks.push({
        id: 'key-type', label: 'Key type', status: 'warn',
        message: 'This is a TEMPORARY key (starts with "ASIA") — it will stop working within hours.',
        tip: 'Create a permanent access key for an IAM user instead (starts with "AKIA").',
        consoleUrl: AWS_CONSOLE.iamUsers, consoleLabel: 'Open IAM users',
      });
    }

    const secret = { accessKeyId, secretAccessKey };
    // NON-secret summary only. Never include the secret here.
    const metadata: Record<string, unknown> = { accessKeyIdPrefix: accessKeyId.slice(0, 8), region };
    const provider = new AWSProvider(secret);

    // 2. Sign in -------------------------------------------------------------
    try {
      const who = await provider.getCallerIdentity();
      metadata.accountId = who.accountId;
      metadata.arn = who.arn;
      const isRoot = /:root$/.test(who.arn);
      checks.push(isRoot
        ? {
            id: 'signin', label: 'Sign in to AWS', status: 'warn',
            message: `AWS accepted the key — but it's your account's ROOT key (account ${who.accountId}).`,
            tip: 'It works, but a root key can do anything to your account. Safer: create an IAM user with AmazonEC2FullAccess and use its key instead.',
            consoleUrl: AWS_CONSOLE.iamUsers, consoleLabel: 'Open IAM users',
          }
        : { id: 'signin', label: 'Sign in to AWS', status: 'pass', message: `AWS accepted the key: ${who.arn}` });
    } catch (error) {
      const f = toFriendlyError(error, 'aws');
      checks.push({
        id: 'signin', label: 'Sign in to AWS', status: 'fail', message: f.title,
        tip: f.fixes.join(' '), consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel,
      });
      return outcome(checks, undefined, metadata);
    }

    // 3. Permission to launch (DryRun — nothing is created) ------------------
    try {
      await provider.dryRunLaunch(region, 'g4dn.xlarge');
      checks.push({ id: 'permissions', label: 'Permission to launch machines', status: 'pass', message: `EC2 would allow launching a g4dn.xlarge in ${region} (tested with a dry run).` });
    } catch (error: any) {
      const f = toFriendlyError(error, 'aws');
      if (f.code === 'AWS_PERMISSION') {
        checks.push({
          id: 'permissions', label: 'Permission to launch machines', status: 'fail',
          message: f.title,
          tip: `In IAM, attach to this user ${AWS_REQUIRED_PERMISSIONS}. Wait a minute, then check again.`,
          consoleUrl: AWS_CONSOLE.iamUsers, consoleLabel: 'Open IAM users',
        });
        return outcome(checks, undefined, metadata);
      }
      // Anything else (account still verifying, region not enabled, a
      // quota dry-run answer...) doesn't prove the key is bad: warn.
      checks.push({
        id: 'permissions', label: 'Permission to launch machines', status: 'warn',
        message: `Couldn't confirm launch permission in ${region}: ${f.title}`,
        tip: f.fixes.join(' '), consoleUrl: f.consoleUrl, consoleLabel: f.consoleLabel,
      });
    }

    // 4 + 5. GPU quotas (Service Quotas) --------------------------------------
    const quotaCheck = async (id: string, label: string, code: string, url: string, what: string) => {
      try {
        const limit = await provider.getEc2Quota(region, code);
        metadata[id === 'gpu-quota' ? 'gpuVcpuQuota' : 'spotGpuVcpuQuota'] = limit;
        checks.push(limit >= MIN_VCPUS
          ? { id, label, status: 'pass', message: `Up to ${limit} vCPUs of GPU machines at once in ${region} (a g4dn.xlarge uses 4).` }
          : {
              id, label, status: 'warn',
              message: `Your ${what} GPU quota in ${region} is ${limit} vCPUs — launching needs at least ${MIN_VCPUS}.`,
              tip: `Open Service Quotas (button), check the region at the top right is ${region}, click "Request increase at account level" and ask for 4 (or 8 for the 2xlarge sizes). Approval takes minutes to 2 days.`,
              consoleUrl: url, consoleLabel: 'Request quota',
            });
      } catch (error: any) {
        const f = toFriendlyError(error, 'aws');
        checks.push({
          id, label, status: 'warn',
          message: f.code === 'AWS_PERMISSION'
            ? `Couldn't read your ${what} GPU quota — the key isn't allowed to read Service Quotas.`
            : `Couldn't read your ${what} GPU quota: ${f.title}`,
          tip: f.code === 'AWS_PERMISSION'
            ? 'Not required, but attaching "ServiceQuotasReadOnlyAccess" lets us warn you early. Meanwhile check the quota yourself (button) — new accounts often start at 0.'
            : 'Check the quota yourself (button) — new accounts often start at 0.',
          consoleUrl: url, consoleLabel: 'Open quota',
        });
      }
    };
    await quotaCheck('gpu-quota', `GPU quota in ${region}`, QUOTA_ON_DEMAND_G, regional(AWS_CONSOLE.gpuQuota, region), 'on-demand');
    await quotaCheck('spot-quota', `Spot GPU quota in ${region}`, QUOTA_SPOT_G, regional(AWS_CONSOLE.spotGpuQuota, region), 'spot');

    // 6. Default VPC -----------------------------------------------------------
    try {
      const hasVpc = await provider.hasDefaultVpc(region);
      checks.push(hasVpc
        ? { id: 'network', label: 'Network', status: 'pass', message: `${region} has a default VPC to put machines in.` }
        : {
            id: 'network', label: 'Network', status: 'warn',
            message: `${region} has no default VPC, which machines are created in.`,
            tip: `VPC console → Your VPCs → Actions → "Create default VPC" (in ${region}), or run: aws ec2 create-default-vpc --region ${region}`,
            consoleUrl: `https://${region}.console.aws.amazon.com/vpcconsole/home?region=${region}#vpcs:`,
            consoleLabel: 'Open VPCs',
          });
    } catch (error) {
      checks.push({ id: 'network', label: 'Network', status: 'warn', message: 'Couldn\'t check the network.', tip: toFriendlyError(error, 'aws').title });
    }

    return outcome(checks, secret, metadata);
  },
};
