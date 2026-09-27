/**
 * ============================================================================
 * src/providers/aws/errors.ts — TURN AMAZON WEB SERVICES ERRORS INTO PLAIN ENGLISH
 * ============================================================================
 *
 * AWS errors come with a short machine-readable CODE plus a message, e.g.
 *   code:    "VcpuLimitExceeded"
 *   message: "You have requested more vCPU capacity than your current vCPU
 *             limit of 0 allows for the instance bucket that the specified
 *             instance type belongs to..."
 * The aws-sdk puts the code in `error.code`, and the shared errorText()
 * helper (src/providers/errors.ts) glues code + message together, so the
 * patterns below can match either.
 *
 * Each rule turns one kind of error into a FriendlyError: a short title,
 * what it means, the exact steps to fix it, and (where useful) a direct link
 * to the right AWS console page. The frontend shows this as an error card.
 *
 * ADDING A NEW CASE: add an entry to AWS_RULES. Rules are checked top to
 * bottom and the first match wins, so specific rules go before general ones.
 * ============================================================================
 */

import { FriendlyError, FriendlyCloudError, Rule, errorText, toFriendlyError } from '../errors';
// Re-exported so AWS code can import everything error-related from here.
export { FriendlyError, FriendlyCloudError, toFriendlyError };

/**
 * Direct links to the AWS console pages that fix the common problems.
 * (Console links without a region open in the region you last used; the
 * pages tell you to check the region selector at the top right.)
 */
export const AWS_CONSOLE = {
  iamUsers: 'https://console.aws.amazon.com/iam/home#/users',
  gpuQuota: 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-DB2E81BA',
  spotGpuQuota: 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-3819A6DF',
  vpcs: 'https://console.aws.amazon.com/vpcconsole/home#vpcs:',
  instances: 'https://console.aws.amazon.com/ec2/home#Instances:',
  snapshots: 'https://console.aws.amazon.com/ec2/home#Snapshots:',
  accountRegions: 'https://console.aws.amazon.com/billing/home#/account',
  costExplorer: 'https://console.aws.amazon.com/cost-management/home#/cost-explorer',
};

/** The IAM permissions our app needs — quoted whenever a permission is missing. */
export const AWS_REQUIRED_PERMISSIONS =
  'the AWS managed policy "AmazonEC2FullAccess" (machines, disks, snapshots, security groups), ' +
  'plus optionally "ServiceQuotasReadOnlyAccess" (so we can check your GPU quota) and "ce:GetCostAndUsage" (real spend reports)';

export const AWS_RULES: Rule[] = [
  // ---- Credentials ------------------------------------------------------
  {
    // InvalidClientTokenId = the access key ID doesn't exist (typo, deleted).
    // SignatureDoesNotMatch = the key ID exists but the secret is wrong.
    // AuthFailure = EC2's word for either of the above.
    test: /InvalidClientTokenId|SignatureDoesNotMatch|AuthFailure|InvalidAccessKeyId|UnrecognizedClientException|security token included in the request is invalid/i,
    build: (raw) => {
      const badSecret = /SignatureDoesNotMatch/i.test(raw);
      return {
        code: 'AWS_KEY_INVALID',
        title: badSecret ? 'AWS rejected the secret access key' : 'AWS doesn\'t recognise this access key',
        explanation: badSecret
          ? 'The access key ID exists, but the secret access key paired with it is wrong (often a character was lost while copying).'
          : 'The access key ID is mistyped, was deleted or deactivated in IAM, or belongs to a different AWS partition (China / GovCloud).',
        fixes: [
          'In the AWS console open IAM → Users → your user → "Security credentials" and check the key is listed as Active.',
          'If you no longer have the secret (AWS shows it only once), click "Create access key" to make a new pair.',
          'On the Config page here, remove the AWS credentials and add them again, pasting both values carefully (no spaces).',
        ],
        consoleUrl: AWS_CONSOLE.iamUsers,
        consoleLabel: 'Open IAM users',
      };
    },
  },
  {
    test: /ExpiredToken|RequestExpired|token.*expired/i,
    build: () => ({
      code: 'AWS_KEY_EXPIRED',
      title: 'These AWS credentials have expired',
      explanation:
        'Temporary keys (starting "ASIA…") only last a few hours — or the server\'s clock is badly wrong. The app needs a permanent IAM user key (starting "AKIA…").',
      fixes: [
        'Create a permanent access key for an IAM user: IAM → Users → your user → Security credentials → Create access key.',
        'Replace the AWS credentials on the Config page with the new key.',
      ],
      consoleUrl: AWS_CONSOLE.iamUsers,
      consoleLabel: 'Open IAM users',
    }),
  },

  // ---- New accounts / regions not switched on ---------------------------
  {
    test: /OptInRequired|not subscribed to this service|PendingVerification|account.*(is|being) (verified|validated)/i,
    build: (raw) => {
      const verifying = /PendingVerification|verif|validat/i.test(raw);
      return {
        code: 'AWS_ACCOUNT_NOT_READY',
        title: verifying ? 'Your AWS account is still being verified' : 'This AWS region isn\'t switched on for your account',
        explanation: verifying
          ? 'Brand-new AWS accounts can\'t launch machines until AWS finishes verifying them — usually minutes, occasionally up to 24 hours.'
          : 'Some regions (e.g. Hong Kong, Jakarta, the Middle East) are "opt-in" and must be enabled first. A brand-new account may also still be activating.',
        fixes: [
          'Check your email for a message from AWS about account activation or verification.',
          'For opt-in regions: AWS console → your account name (top right) → Account → "AWS Regions" → Enable.',
          'Or pick a different region here (Singapore, Tokyo, Sydney, the US and EU regions are on by default).',
          'If it has been more than a day, open an AWS Support case (free for account questions).',
        ],
        consoleUrl: AWS_CONSOLE.accountRegions,
        consoleLabel: 'Open account settings',
      };
    },
  },

  // ---- Permissions ------------------------------------------------------
  {
    // EC2: "UnauthorizedOperation: You are not authorized to perform this
    // operation. User: arn:aws:iam::123:user/x is not authorized to perform:
    // ec2:RunInstances on resource: ..." — other services say AccessDenied.
    test: /UnauthorizedOperation|AccessDenied|not authorized to perform|is not authorized/i,
    build: (raw) => {
      // Pull out the action name ("ec2:RunInstances") when AWS includes it.
      const action = raw.match(/perform:?\s*([a-z0-9-]+:[A-Za-z0-9*]+)/)?.[1];
      return {
        code: 'AWS_PERMISSION',
        title: action ? `Your AWS key isn't allowed to do "${action}"` : 'Your AWS key isn\'t allowed to do that',
        explanation: 'The key is valid, but the IAM user it belongs to doesn\'t have permission for this action.',
        fixes: [
          'Open IAM → Users → the user this key belongs to → "Add permissions" → "Attach policies directly".',
          `Attach ${AWS_REQUIRED_PERMISSIONS}.`,
          'Save, wait about a minute for AWS to apply it, then try again.',
          'If your company uses AWS Organizations, a Service Control Policy may also block EC2 in this region — ask your administrator.',
        ],
        consoleUrl: AWS_CONSOLE.iamUsers,
        consoleLabel: 'Open IAM users',
      };
    },
  },

  // ---- Quotas -----------------------------------------------------------
  {
    test: /MaxSpotInstanceCountExceeded|Max spot instance count exceeded|spot.*vCPU.*limit/i,
    build: () => ({
      code: 'AWS_SPOT_QUOTA',
      title: 'No spot GPU quota on your AWS account yet',
      explanation:
        'AWS limits how many spot vCPUs you can run per machine family, per region. New accounts often start at 0 for GPU ("G and VT") spot instances.',
      fixes: [
        'Click the button below (Service Quotas → "All G and VT Spot Instance Requests").',
        'Make sure the region selector at the top right of the console shows the region you\'re launching in.',
        'Click "Request increase at account level", ask for at least 4 (a g4dn.xlarge / g5.xlarge is 4 vCPUs; the 2xlarge sizes are 8) and submit.',
        'Or turn Spot off and launch on-demand, which uses a separate quota.',
      ],
      consoleUrl: AWS_CONSOLE.spotGpuQuota,
      consoleLabel: 'Request spot GPU quota',
    }),
  },
  {
    test: /VcpuLimitExceeded|vCPU capacity|vCPU limit|InstanceLimitExceeded/i,
    build: () => ({
      code: 'AWS_GPU_QUOTA',
      title: 'Your AWS account isn\'t allowed enough GPU vCPUs yet',
      explanation:
        'AWS limits how many vCPUs of each machine family you can run at once, per region. New accounts usually start at 0 for GPU ("G and VT") instances, so the first launch fails until you ask for more.',
      fixes: [
        'Click the button below (Service Quotas → "Running On-Demand G and VT instances").',
        'Check the region selector at the top right of the AWS console matches the region you picked here.',
        'Click "Request increase at account level", enter 4 (one g4dn.xlarge / g5.xlarge) or 8 (the 2xlarge sizes), and submit with a reason like "personal cloud gaming".',
        'Approval takes from minutes to 1–2 business days; AWS emails you. Very new accounts are sometimes asked to open a support case.',
      ],
      consoleUrl: AWS_CONSOLE.gpuQuota,
      consoleLabel: 'Request GPU quota',
    }),
  },

  // ---- Capacity ---------------------------------------------------------
  {
    test: /InsufficientInstanceCapacity|InsufficientCapacity|insufficient capacity|capacity-not-available/i,
    build: () => ({
      code: 'AWS_NO_CAPACITY',
      title: 'AWS is out of these GPU machines in this area right now',
      explanation:
        'This isn\'t a problem with your account — AWS temporarily has no spare machines of this type in the availability zones we tried. It usually clears within minutes to hours.',
      fixes: [
        'Try again in a few minutes.',
        'Or pick a different machine type (g4dn ↔ g5) or a different region.',
        'Spot machines are the first to run out; switching spot off can help.',
      ],
    }),
  },
  {
    test: /InsufficientFreeAddressesInSubnet/i,
    build: () => ({
      code: 'AWS_SUBNET_FULL',
      title: 'The network has no free IP addresses left',
      explanation: 'The default VPC subnet in this availability zone has run out of private IP addresses (usually because many machines are running there).',
      fixes: ['Terminate machines you no longer need in this region.', 'Or pick a different region.'],
      consoleUrl: AWS_CONSOLE.instances,
      consoleLabel: 'Open EC2 instances',
    }),
  },
  {
    // "Unsupported: Your requested instance type (g5.xlarge) is not supported
    // in your requested Availability Zone (ap-southeast-1c)."
    test: /\bUnsupported\b|not supported in your requested Availability Zone/i,
    build: () => ({
      code: 'AWS_TYPE_NOT_IN_ZONE',
      title: 'This machine type isn\'t offered in this region\'s zones',
      explanation:
        'Not every data centre ("availability zone") has every GPU type. We try each zone of the region in turn; none of them offered this one.',
      fixes: ['Pick a different machine type (g4dn is offered in more places than g5).', 'Or pick a different region.'],
    }),
  },

  // ---- Missing things ---------------------------------------------------
  {
    test: /VPCIdNotSpecified|No default VPC|AWS_NO_DEFAULT_VPC|InvalidVpcID\.NotFound/i,
    build: () => ({
      code: 'AWS_NO_DEFAULT_VPC',
      title: 'This region has no default VPC (network)',
      explanation:
        'Machines are created in the region\'s "default VPC" — the ready-made network every AWS account gets. It has been deleted in this region.',
      fixes: [
        'In the AWS console, switch to this region, open VPC → "Your VPCs" → Actions → "Create default VPC".',
        'Or with the AWS CLI: aws ec2 create-default-vpc --region <region>',
        'Then try again.',
      ],
      consoleUrl: AWS_CONSOLE.vpcs,
      consoleLabel: 'Open VPCs',
    }),
  },
  {
    test: /InvalidAMIID/i,
    build: () => ({
      code: 'AWS_AMI_INVALID',
      title: 'The machine image (AMI) wasn\'t found',
      explanation:
        'The Ubuntu image (or the temporary image made from your snapshot) doesn\'t exist in this region — images belong to one region — or was just deleted.',
      fixes: ['Try again — we look up the newest Ubuntu image every time.', 'If restoring a snapshot, check the snapshot still exists.'],
    }),
  },
  {
    test: /InvalidSnapshot\.NotFound|InvalidSnapshotID|InvalidSnapshot\.Malformed/i,
    build: () => ({
      code: 'AWS_SNAPSHOT_NOT_FOUND',
      title: 'That snapshot no longer exists at AWS',
      explanation: 'It may have been deleted in the AWS console, or it lives in a different region.',
      fixes: ['Refresh the snapshots list.', 'If it\'s gone, delete it here to clean up the record.'],
      consoleUrl: AWS_CONSOLE.snapshots,
      consoleLabel: 'Open EC2 snapshots',
    }),
  },
  {
    test: /InvalidInstanceID\.(NotFound|Malformed)/i,
    build: () => ({
      code: 'NOT_FOUND',
      title: 'AWS couldn\'t find that machine',
      explanation: 'The machine no longer exists at AWS — it may have been terminated in the console — or it\'s in a different region.',
      fixes: ['Press "Sync" to refresh the machine\'s real state.', 'If it\'s gone, delete it here to clean up the record.'],
      consoleUrl: AWS_CONSOLE.instances,
      consoleLabel: 'Open EC2 instances',
    }),
  },
  {
    test: /IncorrectInstanceState|IncorrectState|IncorrectSpotRequestState/i,
    build: () => ({
      code: 'AWS_WRONG_STATE',
      title: 'The machine is busy changing state',
      explanation: 'AWS can\'t do that while the machine is starting, stopping or being created. It has to finish first.',
      fixes: ['Wait a minute, press "Sync", then try again.'],
    }),
  },

  // ---- Throttling -------------------------------------------------------
  {
    test: /RequestLimitExceeded|Throttling|TooManyRequests|Rate exceeded/i,
    build: () => ({
      code: 'AWS_THROTTLED',
      title: 'AWS asked us to slow down',
      explanation: 'Too many requests were sent to AWS in a short time. Nothing is broken.',
      fixes: ['Wait a minute and try again.'],
    }),
  },
];

/**
 * Is this the kind of error where trying ANOTHER AVAILABILITY ZONE might
 * work? (AWS sold out of this GPU type in that zone, the type isn't offered
 * in that zone at all, or that zone's subnet is full.) Quota, permission and
 * credential errors are not — they'd fail everywhere, so we stop instead.
 */
export function isAwsCapacityError(error: unknown): boolean {
  const raw = errorText(error);
  if (/VcpuLimitExceeded|MaxSpotInstanceCountExceeded|UnauthorizedOperation|AccessDenied|AuthFailure|OptInRequired|PendingVerification/i.test(raw)) {
    return false;
  }
  return /InsufficientInstanceCapacity|InsufficientCapacity|\bUnsupported\b|not supported in your requested Availability Zone|InsufficientFreeAddressesInSubnet|capacity-not-available/i.test(raw);
}
