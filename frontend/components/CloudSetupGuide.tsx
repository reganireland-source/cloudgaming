'use client';

/**
 * ============================================================================
 * frontend/components/CloudSetupGuide.tsx — STEP-BY-STEP CLOUD ACCOUNT SETUP
 * ============================================================================
 *
 * Detailed instructions for getting the credentials each cloud needs, shown
 * on the Config page (app/settings/page.tsx) under the credential form.
 *
 * DESIGN: THE CONTENT IS DATA
 * ---------------------------
 * Everything the guide says lives in the GUIDES object below — one entry per
 * cloud, each with: things to know first, numbered steps (a title plus a
 * longer explanation), which value goes into which form field, the GPU
 * quota request, and warnings. The JSX at the bottom just loops over that
 * data. To change the wording, edit GUIDES; you don't need to touch the layout.
 *
 * WHY THE GPU QUOTA SECTION MATTERS
 * ---------------------------------
 * New AWS, Azure and Google Cloud accounts are usually allowed ZERO GPU
 * machines until you ask for more. Launching fails with a quota error until
 * the request is approved, which can take hours or a few days — so do it first.
 *
 * NOTE ON LINKS: they point at each provider's web console. Consoles get
 * redesigned occasionally; if a deep link lands on the wrong page, the menu
 * path written in each step is the reliable route.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import { fillCommand, type CommandContext } from '@/lib/commandContext';

type ProviderKey = 'aws' | 'azure' | 'gcp' | 'oracle';

/** One numbered step: a short title, a fuller explanation, optional link. */
interface Step {
  title: string;
  detail: string;
  link?: { href: string; label: string };
}

/** Everything the guide shows for one cloud. */
interface Guide {
  label: string;
  accent: string;          // Tailwind text colour class for this cloud's headings
  status: string;          // how well the app supports this cloud today
  timeNeeded: string;
  beforeYouStart: string[];
  steps: Step[];
  /** The same setup as one script for the cloud's browser shell (instead of clicking through the steps). */
  setupCli?: { shell: string; href: string; code: string; note?: string };
  fields: { field: string; value: string; example: string }[]; // form field -> what to paste
  quota: {
    summary: string;
    steps: string[];
    /** Direct links to the quota pages in the cloud console. */
    links?: { href: string; label: string }[];
    /** The same request from the command line, for the cloud's browser shell. */
    cli?: { shell: string; href: string; code: string; note?: string };
  };
  /** EXPERIMENTAL "Big screen" (GRID driver, screens up to 4096×2160): extra quota / steps, if any. */
  bigScreen: {
    available: boolean;
    summary: string;
    steps: string[];
    cli?: { shell: string; href: string; code: string; note?: string };
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// THE CONTENT
// ---------------------------------------------------------------------------
const GUIDES: Record<ProviderKey, Guide> = {
  gcp: {
    label: 'Google Cloud',
    accent: 'text-neon-lime',
    status: 'Launch, start, stop, delete, snapshots and live setup progress are built. Not yet tested end to end on a real project.',
    timeNeeded: '~15 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'A Google Cloud project with billing linked. Free-trial accounts can\'t use GPUs — click "Activate full account" first.',
      'Suggested region: asia-southeast1 (Singapore). Pick the one closest to you in the launch form.',
    ],
    steps: [
      { title: 'Pick (or create) a project and note its Project ID', detail: 'Use the project picker at the top of the console. Copy the Project ID (e.g. "my-gaming-412305") — not the display name.', link: { href: 'https://console.cloud.google.com/projectselector2/home/dashboard', label: 'Open project picker' } },
      { title: 'Enable the Compute Engine API', detail: 'APIs & Services → Library → "Compute Engine API" → Enable. Takes a minute or two the first time.', link: { href: 'https://console.cloud.google.com/apis/library/compute.googleapis.com', label: 'Open Compute Engine API' } },
      { title: 'Create a service account (the app\'s identity)', detail: 'IAM & Admin → Service Accounts → Create service account. Name: "cloudgaming-hub" → Create and continue.', link: { href: 'https://console.cloud.google.com/iam-admin/serviceaccounts/create', label: 'Create service account' } },
      { title: 'Give it the "Compute Admin" role', detail: 'In "Grant this service account access to project", add Compute Admin (creates machines, disks, snapshots and the streaming firewall rule) → Continue → Done. "Service Account User" is optional — the app doesn\'t attach service accounts to machines.' },
      { title: 'Create a JSON key', detail: 'Click the service account → Keys → Add key → Create new key → JSON → Create. A .json file downloads. If you see "Service account key creation is disabled", see that entry under TROUBLESHOOTING below.' },
      { title: 'Add it on this page', detail: 'Under YOUR_CLOUD_KEYS → Google Cloud → Add keys, click "Upload file" and pick the .json (or paste all of it). Project ID can be left blank — it\'s read from the file. Press "Check & save": the app signs in, reads your GPU quotas and network, and only saves if nothing fails.' },
      { title: '(Optional) Let the app read your actual bill', detail: 'Google only provides billed costs through its billing export to BigQuery: Billing → Billing export → BigQuery export → Standard usage cost → pick this project, create a dataset (e.g. "billing"), save. Give the service account "BigQuery Job User" on the project and "BigQuery Data Viewer" on the dataset. A few hours later a table gcp_billing_export_v1_… appears: paste its full name on the Costs page. Data starts from the day you turn it on.', link: { href: 'https://console.cloud.google.com/billing/export', label: 'Billing export' } },
    ],
    fields: [
      { field: 'Service account key (JSON)', value: 'The whole downloaded key file (step 5)', example: '{ "type": "service_account", "project_id": … }' },
      { field: 'Project ID (optional)', value: 'Only if different from the key\'s project', example: 'my-gaming-412305' },
    ],
    quota: {
      summary: 'Google has TWO GPU limits and both must be at least 1: a global "GPUs (all regions)" count and a per-region count for the GPU model. New projects start at 0. The key check on this page tells you which one is missing.',
      steps: [
        'IAM & Admin → Quotas & System Limits.',
        'Filter "GPUs (all regions)" → select → Edit → request at least 1.',
        'Filter "NVIDIA T4 GPUs" (cheapest) or "NVIDIA L4 GPUs" for your region (e.g. asia-southeast1) → request at least 1.',
        'For spot machines, also request "Preemptible NVIDIA T4 GPUs" (or L4).',
        'Quota is per GPU model: T4 quota covers GOOD-tier machines only; BETTER (L4) needs "NVIDIA L4 GPUs" as well. Request both in each region you travel to.',
        'Region names: asia-southeast1 = Singapore, asia-east2 = Hong Kong, asia-east1 = Taiwan, asia-northeast1 = Tokyo, asia-northeast3 = Seoul, asia-south1 = Mumbai, australia-southeast1 = Sydney, us-west1 = Oregon, us-west2 = Los Angeles.',
        'Approval usually takes from a few minutes to 2 business days.',
      ],
      cli: {
        shell: 'Cloud Shell', href: 'https://shell.cloud.google.com/',
        note: 'Your project, region and email are filled in from Config. Run the step-3 lines you need (already asked once? use the Quotas page instead). If "beta" isn\'t recognised, try "gcloud quotas".',
        code: `P=<your-project-id>
R=asia-southeast1   # your region

# 1. Current GPU limits (0 = request an increase)
gcloud compute project-info describe --project $P --flatten=quotas \\
  --filter="quotas.metric~GPUS" --format="table(quotas.metric,quotas.limit,quotas.usage)"
gcloud compute regions describe $R --project $P --flatten=quotas \\
  --filter="quotas.metric~GPU" --format="table(quotas.metric,quotas.limit,quotas.usage)"

# 2. The quota IDs to request
gcloud services enable cloudquotas.googleapis.com --project $P
gcloud beta quotas info list --service=compute.googleapis.com --project=$P --billing-project=$P \\
  --filter="quotaId~GPU" --format="value(quotaId)"

# 3. Request what you need: each line below is one complete command (run only the ones you need)
# Project-wide cap (how many GPU machines can run at once, anywhere):
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=GPUS-ALL-REGIONS-per-project --preferred-value=1 --email=<your email> --justification="Personal cloud gaming VM"
# GOOD tier (T4), on-demand / spot:
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=NVIDIA-T4-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=PREEMPTIBLE-NVIDIA-T4-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
# BETTER / BEST tiers (L4), on-demand / spot:
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=NVIDIA-L4-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=PREEMPTIBLE-NVIDIA-L4-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"`,
      },
    },
    bigScreen: {
      available: true,
      summary: 'Big screen runs on Google\'s "vWS" (RTX Virtual Workstation) GPUs: the same T4 / L4 chips with NVIDIA\'s licensed GRID driver, billed about USD 0.20 per GPU-hour extra (estimate — see Google\'s GPU pricing). vWS GPUs have their OWN quota, separate from the normal GPU quota above: request it before launching with Big screen, or the launch fails with a quota error.',
      steps: [
        'IAM & Admin → Quotas & System Limits → filter "Virtual Workstation".',
        'GOOD tier (T4): request "NVIDIA T4 Virtual Workstation GPUs" = 1 in your region. BETTER / BEST (L4): "NVIDIA L4 Virtual Workstation GPUs" = 1.',
        'Spot big-screen machines also need the "Preemptible" version of the same vWS quota.',
        '"GPUs (all regions)" must still be at least 1 (same as for normal machines).',
        'Not every zone sells vWS GPUs: step 2 below shows where they are. Approval: minutes to 2 business days.',
      ],
      cli: {
        shell: 'Cloud Shell', href: 'https://shell.cloud.google.com/',
        note: 'Your project, region and email are filled in from Config. Run the step-4 lines you need; "GPUs (all regions)" must also be at least 1.',
        code: `P=<your-project-id>
R=asia-southeast1   # your region

# 1. Current vWS GPU limits in the region (0 = request an increase)
gcloud compute regions describe $R --project $P --flatten=quotas \\
  --filter="quotas.metric~VWS" --format="table(quotas.metric,quotas.limit,quotas.usage)"

# 2. Which zones of the region sell vWS GPUs
gcloud compute accelerator-types list --project $P \\
  --filter="name~vws AND zone~$R" --format="table(name,zone)"

# 3. The vWS quota IDs to request
gcloud services enable cloudquotas.googleapis.com --project $P
gcloud beta quotas info list --service=compute.googleapis.com --project=$P --billing-project=$P \\
  --filter="quotaId~VWS" --format="value(quotaId)"

# 4. Request what you need: each line below is one complete command (run only the ones you need)
# GOOD tier big screen (T4 vWS), on-demand / spot:
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=NVIDIA-T4-VWS-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=PREEMPTIBLE-NVIDIA-T4-VWS-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
# BETTER / BEST big screen (L4 vWS), on-demand / spot:
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=NVIDIA-L4-VWS-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"
gcloud beta quotas preferences create --project=$P --billing-project=$P --service=compute.googleapis.com --quota-id=PREEMPTIBLE-NVIDIA-L4-VWS-GPUS-per-project-region --preferred-value=1 --dimensions=region=$R --email=<your email> --justification="Personal cloud gaming VM"`,
      },
    },
    warnings: [
      'The JSON key file is a password — don\'t commit it to git or share it. Delete keys you no longer use (Keys tab).',
      'The app creates a firewall rule "cloudgaming-sunshine" that opens the streaming ports to machines tagged with it. SSH is not opened.',
    ],
  },
  aws: {
    label: 'Amazon Web Services',
    accent: 'text-neon-cyan',
    status: 'Launch, start, stop, delete, snapshots and live setup progress are built. Not yet tested end to end on a real account.',
    timeNeeded: '~15 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'An AWS account with a payment method. GPU machines are not in the free tier.',
      'Sign in as an administrator — but don\'t give the app your root login; you\'ll create a limited user below.',
      'The region needs a default VPC (every account has one unless it was deleted). The key check warns if it\'s missing.',
    ],
    steps: [
      { title: 'Create a dedicated IAM user', detail: 'IAM → Users → Create user. Name: "cloudgaming-hub". Don\'t tick console access — the app only needs an access key.', link: { href: 'https://console.aws.amazon.com/iam/home#/users/create', label: 'Create IAM user' } },
      { title: 'Attach its permissions', detail: 'Attach policies directly: AmazonEC2FullAccess (required — machines, disks, snapshots, security group). Optional: ServiceQuotasReadOnlyAccess (lets the key check read your GPU quota) and a policy allowing ce:GetCostAndUsage (real spend reports).' },
      { title: 'Create an access key', detail: 'Open the user → Security credentials → Create access key → "Application running outside AWS" → Create.' },
      { title: 'Copy both halves immediately', detail: 'The Access key ID (starts with AKIA) and the Secret access key. The secret is shown ONLY once.' },
      { title: '(Optional) Let the app read your actual bill', detail: 'Add an inline policy to the user allowing ce:GetCostAndUsage and ce:UpdateCostAllocationTagsStatus (the app switches on the "app" cost allocation tag so it can report only its own resources). AWS charges USD 0.01 per Cost Explorer request; the app asks at most every 6 hours.' },
      { title: 'Add it on this page', detail: 'YOUR_CLOUD_KEYS → AWS → Add keys → paste both → "Check & save". The check signs in, does a dry-run launch to confirm permissions, reads your GPU quota and checks the default VPC. Regions are chosen per machine in the launch form.' },
    ],
    setupCli: {
      shell: 'CloudShell', href: 'https://console.aws.amazon.com/cloudshell/home',
      note: 'Does steps 1–5 in one go. Run it as an administrator. The last line prints the Access key ID and Secret access key, tab-separated; the secret is shown only this once. Re-running is safe apart from the key: an IAM user can have at most 2 access keys.',
      code: `U=cloudgaming-hub

# 1. The app's own user (no console login)
aws iam create-user --user-name $U

# 2. Permissions: machines, disks, snapshots, security group + reading GPU quota
aws iam attach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess
aws iam attach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/ServiceQuotasReadOnlyAccess

# 5. (Optional) Read the actual bill from Cost Explorer
aws iam put-user-policy --user-name $U --policy-name cloudgaming-billing --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["ce:GetCostAndUsage", "ce:UpdateCostAllocationTagsStatus"], "Resource": "*" }]
}'

# 3-4. The access key: paste both values into the form
aws iam create-access-key --user-name $U --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text`,
    },
    fields: [
      { field: 'Access key ID', value: 'From step 4', example: 'AKIAIOSFODNN7EXAMPLE' },
      { field: 'Secret access key', value: 'From step 4 (shown once)', example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY…' },
    ],
    quota: {
      links: [
        { href: 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-DB2E81BA', label: 'On-demand G and VT (L-DB2E81BA)' },
        { href: 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-3819A6DF', label: 'Spot G and VT (L-3819A6DF)' },
        { href: 'https://console.aws.amazon.com/servicequotas/home/requests', label: 'Your quota requests' },
      ],
      summary: 'New AWS accounts have a GPU limit of 0 vCPUs. The limit is counted in vCPUs, not machines: a g4dn.xlarge needs 4, a 2xlarge needs 8.',
      steps: [
        'Service Quotas → AWS services → Amazon EC2, in the region you\'ll use.',
        'Find "Running On-Demand G and VT instances" (quota code L-DB2E81BA) → Request increase at account level → 8. "Account level" is just AWS\'s name for your account\'s limit: it still applies only to the region selected.',
        'For spot machines, also request "All G and VT Spot Instance Requests" (quota code L-3819A6DF) → 8.',
        'Or use the direct links below: each opens that quota in the region currently selected in the console (top right), so check the region before requesting.',
        'Quota is per region: switch region (top right) and repeat for each place you travel to.',
        'Opt-in regions must be switched on first: Account → AWS Regions → Enable, then wait a few minutes (until then AWS answers as if your key were wrong). Opt-in: Hong Kong (ap-east-1), Taipei (ap-east-2), Melbourne (ap-southeast-4), Jakarta (ap-southeast-3), Malaysia (ap-southeast-5), Thailand (ap-southeast-7), Hyderabad (ap-south-2), Calgary (ca-west-1), Mexico (mx-central-1), Milan (eu-south-1), Spain (eu-south-2), Zurich (eu-central-2), Tel Aviv (il-central-1), Bahrain (me-south-1), UAE (me-central-1), Cape Town (af-south-1).',
        'Region names — Asia-Pacific: ap-southeast-1 Singapore, ap-southeast-2 Sydney, ap-southeast-4 Melbourne, ap-southeast-3 Jakarta, ap-southeast-5 Malaysia, ap-southeast-7 Thailand, ap-east-1 Hong Kong, ap-east-2 Taipei, ap-northeast-1 Tokyo, ap-northeast-3 Osaka, ap-northeast-2 Seoul, ap-south-1 Mumbai, ap-south-2 Hyderabad. Europe: eu-west-2 London, eu-west-1 Ireland, eu-west-3 Paris, eu-central-1 Frankfurt, eu-central-2 Zurich, eu-north-1 Stockholm, eu-south-1 Milan, eu-south-2 Spain. Americas: us-east-1 N. Virginia, us-east-2 Ohio, us-west-1 N. California, us-west-2 Oregon, ca-central-1 Montréal, ca-west-1 Calgary, mx-central-1 Mexico, sa-east-1 São Paulo. Middle East/Africa: il-central-1 Tel Aviv, me-south-1 Bahrain, me-central-1 UAE, af-south-1 Cape Town.',
        'Not every region sells every GPU (the newest ones often start with T4 only, or none): the Regions page asks AWS and shows "Not sold here" where that\'s the case, so you don\'t request quota for nothing.',
        'Approval takes from minutes to a couple of days; brand-new accounts may be asked for a use case.',
      ],
      cli: {
        shell: 'CloudShell', href: 'https://console.aws.amazon.com/cloudshell/home',
        note: 'L-DB2E81BA = on-demand G/VT, L-3819A6DF = spot G/VT. Edit the region list to the places you travel to.',
        code: `REGIONS="ap-southeast-1 ap-southeast-2 ap-southeast-4 ap-northeast-1 eu-west-2"

# Current limits per region (vCPUs; 0 = blocked)
for R in $REGIONS; do
  echo "$R on-demand=$(aws service-quotas get-service-quota --region $R --service-code ec2 --quota-code L-DB2E81BA --query Quota.Value) spot=$(aws service-quotas get-service-quota --region $R --service-code ec2 --quota-code L-3819A6DF --query Quota.Value)"
done

# Request 8 vCPUs of each (enough for one g5.2xlarge)
for R in $REGIONS; do
  aws service-quotas request-service-quota-increase --region $R --service-code ec2 --quota-code L-DB2E81BA --desired-value 8
  aws service-quotas request-service-quota-increase --region $R --service-code ec2 --quota-code L-3819A6DF --desired-value 8
done

# Opt-in regions (e.g. Hong Kong): which are off, and switch one on
aws ec2 describe-regions --all-regions --query "Regions[?OptInStatus=='not-opted-in'].RegionName" --output text
aws account enable-region --region-name ap-east-1`,
      },
    },
    bigScreen: {
      available: true,
      summary: 'No extra quota or cost: big screen runs on the same g4dn (T4) / g5 (A10G) machines and uses the same "Running On-Demand G and VT instances" (and spot) quota as above. AWS provides the GRID driver and its licence.',
      steps: [
        'Nothing extra to request — tick "Big screen" when launching.',
        'Optional: check the machines can reach AWS\'s GRID driver (it\'s downloaded during setup).',
      ],
      cli: {
        shell: 'CloudShell', href: 'https://console.aws.amazon.com/cloudshell/home',
        code: `# AWS's current GRID driver for Linux (public, no credentials needed)
aws s3 ls --no-sign-request s3://ec2-linux-nvidia-drivers/latest/`,
      },
    },
    warnings: [
      'The app creates a security group "cloudgaming-sunshine" in the default VPC with only the streaming ports open. SSH is not opened.',
      'Stopped machines still pay for their EBS disk (~USD 0.08–0.10/GB-month).',
    ],
  },
  azure: {
    label: 'Microsoft Azure',
    accent: 'text-neon-purple',
    status: 'Launch, start (deallocate/stop), delete, snapshots and live setup progress are built. Not yet tested end to end on a real subscription.',
    timeNeeded: '~15 minutes, plus waiting for GPU quota approval',
    beforeYouStart: [
      'A Pay-As-You-Go subscription. Free-trial and student subscriptions can\'t get GPU quota — upgrade first.',
      'Machines use full NVIDIA T4 GPUs (NCasT4_v3 sizes). The partial-GPU NVadsA10 v5 sizes need special drivers and aren\'t offered.',
    ],
    steps: [
      { title: 'Open Azure Cloud Shell', detail: 'Click the >_ icon at the top of the Azure portal and choose Bash.', link: { href: 'https://portal.azure.com/#cloudshell/', label: 'Open Cloud Shell' } },
      { title: 'Get your Subscription ID', detail: 'Run:  az account show --query id -o tsv' },
      { title: 'Create the app\'s identity with Contributor access', detail: 'Run:  az ad sp create-for-rbac --name cloudgaming-hub --role Contributor --scopes /subscriptions/<SUBSCRIPTION_ID>   It prints appId (Client ID), password (Client secret) and tenant (Tenant ID). The password is shown only once.' },
      { title: 'Actual bill: nothing extra', detail: 'The Contributor role can already read Cost Management, so the Costs page shows what Azure billed (in your billing currency) next to the app\'s estimate. Free-trial and sponsorship subscriptions don\'t offer cost data by API.' },
      { title: 'Add it on this page', detail: 'YOUR_CLOUD_KEYS → Azure → Add keys → paste the four values (or paste the whole JSON that az printed into any field) → "Check & save". The check signs in, confirms permissions, registers the Compute/Network providers if needed and reads your GPU quota.' },
    ],
    fields: [
      { field: 'Tenant ID', value: '"tenant" from step 3', example: '5e6f7a8b-…' },
      { field: 'Client ID', value: '"appId" from step 3', example: '1a2b3c4d-…' },
      { field: 'Client secret', value: '"password" from step 3 (the VALUE, not the secret\'s ID)', example: 'abc8Q~…' },
      { field: 'Subscription ID', value: 'From step 2', example: '00000000-0000-0000-0000-000000000000' },
    ],
    quota: {
      summary: 'GPU quota is per region and per VM family, and starts at 0.',
      steps: [
        'Portal → Quotas → Compute → pick your region.',
        'Find "Standard NCASv3_T4 Family vCPUs" → request 8.',
        'For spot machines, also request "Total Regional Spot vCPUs" → 8.',
        'No NCASv3_T4 row for a region (this happens for Southeast Asia/Singapore on new subscriptions)? Check the machine exists there with  az vm list-skus --location <region> --size Standard_NC4as_T4_v3 --all -o table  (Restrictions should be None). If so, Azure just hasn\'t created the quota for you: open a support request → Service and subscription limits (quotas) → Compute-VM (cores-vCPUs) → that region → NCASv3_T4 → 8. Meanwhile use a nearby region, e.g. Malaysia West (Kuala Lumpur) for Singapore.',
        'az quota update fails with "InvalidResourceName" for a region? Same cause — there\'s no quota entry to update; use the support request above.',
        'Region names in the portal aren\'t cities: Southeast Asia = Singapore, East Asia = Hong Kong, Malaysia West = Kuala Lumpur, Japan East = Tokyo, Japan West = Osaka, Korea Central = Seoul, Central India = Pune, South India = Chennai, Australia East = Sydney.',
        'Requests Azure can’t auto-approve show a red ✗ — that isn’t a refusal; follow up with a support request and they’re reviewed by hand in a few days.',
      ],
      cli: {
        shell: 'Cloud Shell (Bash)', href: 'https://portal.azure.com/#cloudshell/',
        note: '"lowPriorityCores" is Azure\'s internal name for "Total Regional Spot vCPUs".',
        code: `SUB=$(az account show --query id -o tsv); LOC=malaysiawest   # your region
az vm list-usage --location $LOC -o table | grep -Ei "NCASv3_T4|Spot|Low-priority|Total Regional"
az extension add --name quota
# No T4 line here = Azure has no T4 quota entry in this region yet (e.g. Southeast Asia
# on newer subscriptions): the update below fails with "InvalidResourceName" and
# you need a support request instead (see the steps above), or another region.
az quota list --scope "/subscriptions/$SUB/providers/Microsoft.Compute/locations/$LOC" \\
  --query "[?contains(name,'T4')].{name:name, limit:properties.limit.value}" -o table
az quota update --resource-name standardNCASv3_T4Family --resource-type dedicated \\
  --scope "/subscriptions/$SUB/providers/Microsoft.Compute/locations/$LOC" --limit-object value=8
az quota update --resource-name lowPriorityCores --resource-type lowPriority \\
  --scope "/subscriptions/$SUB/providers/Microsoft.Compute/locations/$LOC" --limit-object value=8`,
      },
    },
    bigScreen: {
      available: true,
      summary: 'No extra quota or cost: big screen runs on the same NCasT4_v3 machines and uses the same "Standard NCASv3_T4 Family vCPUs" quota (and "Total Regional Low-priority vCPUs" for spot) as above. Microsoft provides the GRID driver and Azure includes its licence.',
      steps: [
        'Nothing extra to request — tick "Big screen" when launching.',
        'Pick a region where the T4 quota entry exists (the check below, or the Regions page): e.g. Kuala Lumpur (malaysiawest) rather than Singapore on newer subscriptions.',
      ],
      cli: {
        shell: 'Cloud Shell (Bash)', href: 'https://portal.azure.com/#cloudshell/',
        code: `LOC=malaysiawest   # your region
# T4 family (on-demand) and Low-priority (spot) limits here: both need 4+ free vCPUs
az vm list-usage --location $LOC -o table | grep -Ei "NCASv3_T4|Low-priority|Total Regional"`,
      },
    },
    warnings: [
      'Stopping deallocates the VM (compute billing stops). A VM that is merely "stopped" inside Windows/Linux keeps billing — always stop from here.',
      'The app creates a resource group "cloudgaming-hub-<region>" with a VNet and NSG; each machine gets its own public IP, network card and disk, all deleted with it.',
      'Lost or expired secret? Run:  az ad sp credential reset --id <CLIENT_ID>',
    ],
  },
  oracle: {
    label: 'Oracle Cloud',
    accent: 'text-neon-pink',
    status: 'Launch, start, stop, delete, backups and live setup progress are built. Not yet tested end to end on a real tenancy.',
    timeNeeded: '~20 minutes, plus waiting for a GPU limit increase',
    beforeYouStart: [
      'A Pay As You Go account. Free-trial and Always Free accounts can\'t use GPUs.',
      'GPU machines are VM.GPU.A10.1 (NVIDIA A10) — powerful but ~USD 2/hour. Oracle\'s first 10 TB/month of streamed data is free.',
      'If you want a region other than your home region, subscribe to it first (region menu → Manage regions).',
    ],
    steps: [
      { title: 'Create a group and policy (skip if you\'re a tenancy administrator)', detail: 'Identity → Domains → Default → Groups → create "CloudGaming" and add your user. Then Identity & Security → Policies (root compartment) → Create policy → manual editor:  Allow group CloudGaming to manage instance-family in tenancy · Allow group CloudGaming to manage virtual-network-family in tenancy · Allow group CloudGaming to manage volume-family in tenancy · Allow group CloudGaming to read all-resources in tenancy · Allow group CloudGaming to read usage-report in tenancy (lets the Costs page show what Oracle billed)', link: { href: 'https://cloud.oracle.com/identity/domains/policies', label: 'Open Policies' } },
      { title: 'Create an API key', detail: 'Profile (top right) → My profile → API keys → Add API key → Generate API key pair → Download private key → Add.', link: { href: 'https://cloud.oracle.com/identity/domains/my-profile/api-keys', label: 'Open API keys' } },
      { title: 'Copy the configuration preview', detail: 'After adding the key, Oracle shows a "Configuration file preview" with tenancy=, user=, fingerprint= and region=. Copy those four values.' },
      { title: 'Add it on this page', detail: 'YOUR_CLOUD_KEYS → Oracle → Add keys → paste the values and upload the PRIVATE .pem (not the _public.pem) → "Check & save". The check verifies the key and fingerprint locally, signs in, tests permissions and looks for GPU shapes.' },
    ],
    fields: [
      { field: 'Tenancy OCID', value: 'tenancy= from step 3', example: 'ocid1.tenancy.oc1..aaaa…' },
      { field: 'User OCID', value: 'user= from step 3', example: 'ocid1.user.oc1..aaaa…' },
      { field: 'Fingerprint', value: 'fingerprint= from step 3', example: '12:34:56:78:9a:bc:de:f0:…' },
      { field: 'Private key', value: 'The downloaded private .pem', example: '-----BEGIN PRIVATE KEY-----…' },
      { field: 'Region', value: 'region= from step 3', example: 'ap-singapore-1' },
      { field: 'Compartment OCID (optional)', value: 'Blank = the root compartment', example: 'ocid1.compartment.oc1..aaaa…' },
    ],
    quota: {
      summary: 'GPU shapes need a service limit increase, per availability domain.',
      steps: [
        'Governance → Limits, Quotas and Usage → Service: Compute → your region.',
        'Subscribe to the region first if it isn\'t your home region: region menu → Manage regions → Subscribe (takes a few minutes; can\'t be undone).',
        'Search "GPU.A10" ("GPUs for GPU.A10 based VM and BM instances") → Request a service limit increase → 1.',
        'Limits are per region and per availability domain; the app tries every domain, so 1 in any domain is enough.',
        'Approval takes hours to a couple of days.',
      ],
      cli: {
        shell: 'Cloud Shell', href: 'https://cloud.oracle.com/?cloudshell=true',
        note: 'Checking is easy from the command line; the increase request itself is simplest in the console (steps above).',
        code: `# Regions you're subscribed to
oci iam region-subscription list --output table

# Your GPU A10 limits per availability domain (0 = request an increase)
oci limits value list --service-name compute --compartment-id <tenancy-ocid> --all \\
  --query "data[?contains(name,'a10')]" --output table`,
      },
    },
    bigScreen: {
      available: false,
      summary: 'Not available on Oracle: its GPUs need your own NVIDIA virtual-workstation licence (bring your own licence), which the app can\'t provide. Oracle machines stream at up to 2560×1600.',
      steps: [],
    },
    warnings: [
      'Preemptible (spot) Oracle machines can\'t be stopped — only deleted. Use on-demand if you want to stop and resume.',
      'The app creates a VCN "cloudgaming-vcn" with an internet gateway and a security list opening only the streaming ports (SSH is not opened).',
    ],
  },
};

const ORDER: ProviderKey[] = ['gcp', 'aws', 'azure', 'oracle'];

/** Shown under every cloud: what makes a first launch go smoothly. */
const FIRST_LAUNCH_TIPS: React.ReactNode[] = [
  <>Run the <a href="/preflight" className="text-neon-cyan hover:underline">pre-flight check</a> after adding keys — it spots setup mistakes before you pay for a machine.</>,
  <>If a launch fails, the error card starts with its <strong>cause</strong>: Quota, Region, Permissions, Out of stock, Keys or Account. Quota and Region problems are yours to fix (see <a href="/regions" className="text-neon-cyan hover:underline">Regions</a>); Out of stock is the cloud’s and passes on its own.</>,
  <>Start small: on <a href="/recommendations" className="text-neon-cyan hover:underline">Recon</a> pick <strong>Classic</strong> (GOOD tier, T4) with <strong>Reliable</strong> pricing. T4 is the most widely available GPU and needs the smallest quota; on-demand can’t be taken back mid-test.</>,
  <>Turn on <strong>auto-stop</strong> (15 minutes) in the launch form, so a forgotten machine shuts itself down.</>,
  <>No Moonlight on the device you're using? Each machine also opens in a browser tab: <strong>Use the desktop</strong> (reliable, with copy &amp; paste — best for setting things up) or <strong>Play in browser</strong> (full stream in Chrome/Edge, <em>experimental</em>). Both are on the machine card under Connect.</>,
  <>A <strong>stopped</strong> machine still pays for its whole disk every month (≈USD 15–22 for 150 GB). Not playing for a week or more? <strong>Shelve</strong> it (Machines page): the disk is snapshotted and deleted, cutting that to ≈USD 1–7, and <strong>Restore</strong> brings it back with your games in a few minutes. <strong>Auto-shelve</strong> (7 days stopped) does this for you. See <a href="/costs#standing" className="text-neon-cyan hover:underline">Costs → Standing costs</a>.</>,
  <>The <strong>first boot takes 20–35 minutes</strong> (NVIDIA driver, a several-GB streaming container, then Chrome, Discord and Battle.net). The progress bar shows each stage; later starts take 1–2 minutes.</>,
  <>“Out of GPUs in this area” is common and temporary — the app already tries every zone; try again later or another region.</>,
  <>Every machine comes with <strong>Steam, Battle.net, Discord, Google Chrome, Heroic</strong> (Epic &amp; GOG), <strong>Lutris</strong> and <strong>Firefox</strong> — each is its own app in Moonlight. Battle.net installs itself the first time you open it.</>,
  <>Log in to each app <strong>once per machine</strong> — logins are kept on the machine’s disk through stops and restarts until you delete it (a machine launched from a snapshot keeps them too). Tip: Steam, Discord and Battle.net show a <strong>QR code</strong> on their login screen — scan it with their phone app instead of typing passwords over the stream. This app never asks for or stores your game-account passwords.</>,
  <>Machines run Steam on Linux (via Proton). Most Steam games work, but games with kernel anti-cheat — Valorant, Fortnite, Apex, PUBG, Call of Duty — won’t start. Check <a href="https://www.protondb.com" target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline">protondb.com</a> first.</>,
  <>While streaming, press <strong>Ctrl+Alt+Shift+S</strong> in Moonlight for live stats. Good: network latency close to Recon’s estimate, decode under 5 ms, no dropped frames.</>,
  <>Always <strong>stop</strong> from this app (not from inside the machine). Stopped machines still pay for their disk; delete machines you’re done with, then check the <a href="/map" className="text-neon-cyan hover:underline">Map</a> shows no leftovers.</>,
];

/** A copyable block of shell commands for the cloud's browser terminal. */
function CliBlock({ shell, href, code, note }: { shell: string; href: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-neon-amber">Prefer the command line? Do it in {shell}</summary>
      <div className="mt-2 space-y-1.5">
        <div className="flex flex-wrap items-center gap-3 text-[0.72rem]">
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-neon-cyan hover:underline">Open {shell} ↗</a>
          <button type="button" className="text-neon-cyan hover:underline"
            onClick={() => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>
            {copied ? 'Copied' : 'Copy commands'}
          </button>
        </div>
        <pre className="overflow-x-auto rounded bg-black/50 border border-white/10 p-2.5 text-[0.72rem] leading-relaxed text-slate-200"><code className="block whitespace-pre !bg-transparent !border-0 !p-0 !shadow-none">{code}</code></pre>
        {note && <p className="text-[0.7rem] text-slate-400">{note}</p>}
      </div>
    </details>
  );
}

/**
 * @param selected optional: which cloud to show. The Config page passes the
 *                 provider you clicked, so the guide follows your choice.
 */
export default function CloudSetupGuide({ selected, context }: { selected?: ProviderKey | null; context?: CommandContext }) {
  // Which tab is showing. Starts on the page's selection, or AWS.
  const [active, setActive] = useState<ProviderKey>(selected || 'gcp');

  // When the parent's selection changes, follow it. (useEffect with
  // [selected] re-runs whenever `selected` changes.)
  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);

  const guide = GUIDES[active];

  return (
    <div className="neon-card rounded-lg border border-neon-cyan/30 p-3 sm:p-6 mb-6 sm:mb-8">
      <h3 className="text-sm tracking-label font-bold neon-text mb-2 font-mono">[ CREDENTIAL_SETUP_GUIDE ]</h3>
      <p className="text-xs text-slate-400 mb-6 max-w-3xl">
        Step-by-step instructions for creating a limited-access login for the app on each cloud. Do the
        GPU quota request early — it's the step most likely to hold you up.
      </p>

      {/* ---- Tabs: one per cloud ---- */}
      <div className="flex flex-wrap gap-2 mb-6" role="tablist">
        {ORDER.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={active === key}
            onClick={() => setActive(key)}
            className={`px-3 py-1.5 rounded text-[0.72rem] uppercase tracking-label border transition-colors ${
              active === key
                ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.08]'
                : 'border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
            }`}
          >
            {GUIDES[key].label}
          </button>
        ))}
      </div>

      {/* ---- Status + time ---- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6 text-xs">
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <p className="label mb-1">App support</p>
          <p className="text-slate-300">{guide.status}</p>
        </div>
        <div className="rounded border border-white/10 bg-white/[0.02] p-3">
          <p className="label mb-1">Time needed</p>
          <p className="text-slate-300">{guide.timeNeeded}</p>
        </div>
      </div>

      {/* ---- Before you start ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-2 ${guide.accent}`}>Before you start</h4>
        <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-5">
          {guide.beforeYouStart.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </section>

      {/* ---- Numbered steps ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-3 ${guide.accent}`}>Steps</h4>
        <ol className="space-y-3">
          {guide.steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              {/* The step number badge. i starts at 0, so show i + 1. */}
              <span className="flex-shrink-0 w-6 h-6 rounded-full border border-neon-cyan/40 text-neon-cyan text-[0.7rem] flex items-center justify-center">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[0.8rem] text-slate-100 font-medium">{step.title}</p>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{step.detail}</p>
                {step.link && (
                  // target="_blank" opens a new tab; rel="noopener noreferrer"
                  // stops the opened page from controlling this one (a
                  // standard safety measure for external links).
                  <a
                    href={step.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-1 text-[0.72rem] text-neon-cyan hover:underline"
                  >
                    Open {step.link.label} ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
        {guide.setupCli && <CliBlock {...guide.setupCli} code={context ? fillCommand(guide.setupCli.code, context, active) : guide.setupCli.code} />}
      </section>

      {/* ---- Which value goes in which form field ---- */}
      <section className="mb-6">
        <h4 className={`text-[0.8rem] font-semibold mb-2 ${guide.accent}`}>What to paste into the form above</h4>
        {/* overflow-x-auto lets the table scroll sideways on narrow phones */}
        <div className="overflow-x-auto rounded border border-white/10">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="px-3 py-2 font-medium">Form field</th>
                <th className="px-3 py-2 font-medium">What it is</th>
                <th className="px-3 py-2 font-medium">Looks like</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {guide.fields.map((f) => (
                <tr key={f.field}>
                  <td className="px-3 py-2 text-neon-cyan whitespace-nowrap">{f.field.toUpperCase()}</td>
                  <td className="px-3 py-2 text-slate-300">{f.value}</td>
                  <td className="px-3 py-2 text-slate-500 break-all">{f.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- GPU quota ---- */}
      <section className="mb-6 rounded border border-neon-amber/30 bg-neon-amber/[0.05] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-1 text-neon-amber">Request GPU quota (do this first)</h4>
        <p className="text-xs text-slate-300 mb-2 leading-relaxed">{guide.quota.summary}</p>
        <ol className="space-y-1 text-xs text-slate-300 list-decimal pl-5">
          {guide.quota.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {!!guide.quota.links?.length && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {guide.quota.links.map((l) => (
              <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="text-[0.72rem] text-neon-cyan hover:underline">
                Open {l.label} ↗
              </a>
            ))}
          </div>
        )}
        {guide.quota.cli && <CliBlock {...guide.quota.cli} code={context ? fillCommand(guide.quota.cli.code, context, active) : guide.quota.cli.code} />}
        <p className="mt-3 text-xs text-slate-300 leading-relaxed">
          <span className="text-neon-amber">Shortcut:</span> once your keys are saved, the <a href="/regions" className="text-neon-cyan hover:underline">Regions</a> page runs these checks for you across every region and cloud, and shows Ready / No quota / Not enabled with the exact fix for each.
        </p>
      </section>

      {/* ---- Big screen (experimental): extra quota, if any ---- */}
      <section className="mb-6 rounded border border-neon-magenta/30 bg-neon-magenta/[0.04] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-1 text-neon-magenta">
          <span className="mr-1.5 inline-block rounded border border-neon-magenta/50 px-1 text-[0.64rem] uppercase tracking-label align-middle">Experimental</span>
          Big screen (up to 4096×2160){guide.bigScreen.available ? '' : ' — not available'}
        </h4>
        <p className="text-xs text-slate-300 mb-2 leading-relaxed">{guide.bigScreen.summary}</p>
        {guide.bigScreen.steps.length > 0 && (
          <ol className="space-y-1 text-xs text-slate-300 list-decimal pl-5">
            {guide.bigScreen.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        )}
        {guide.bigScreen.cli && <CliBlock {...guide.bigScreen.cli} code={context ? fillCommand(guide.bigScreen.cli.code, context, active) : guide.bigScreen.cli.code} />}
      </section>

      {/* ---- First launch: tips that apply to every cloud ---- */}
      <section className="mb-6 rounded border border-neon-cyan/25 bg-neon-cyan/[0.03] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-2 text-neon-cyan">Your first launch — tips for every cloud</h4>
        <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-5 leading-relaxed">
          {FIRST_LAUNCH_TIPS.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      </section>

      {/* ---- Warnings ---- */}
      <section className="rounded border border-neon-pink/30 bg-neon-pink/[0.05] p-4">
        <h4 className="text-[0.8rem] font-semibold mb-1 text-neon-pink">Keep in mind</h4>
        <ul className="space-y-1 text-xs text-slate-300 list-disc pl-5">
          {guide.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
