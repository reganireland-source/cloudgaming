/**
 * ============================================================================
 * src/services/SshAccessService.ts — WHO MAY SSH INTO THE MACHINES
 * ============================================================================
 *
 * The machines open no SSH by default. For the developer tools (user "dev",
 * key-only login — see providers/shared/devTools.ts) you can let specific
 * IPv4 addresses in on TCP 22, per cloud:
 *   Google  one firewall rule for the app's machines (network tag)
 *   AWS     a rule in the streaming security group of each region you have
 *           machines in (machines in a NEW region later: save again)
 * Never the whole internet: each range must be /16 or narrower.
 * ============================================================================
 */

import { query } from '../config/database';
import { providerFor, listCredentialSummaries } from './CredentialService';
import { MachineRequestError } from './MachineService';
import { CATALOGS } from '../providers/registry';
import { parseSshPublicKey } from '../providers/shared/setupScript';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const MIN_PREFIX = 16;

/** "1.2.3.4" → "1.2.3.4/32"; rejects anything that isn't a narrow public IPv4 range. */
export function normalizeCidrs(input: unknown): string[] {
  if (!Array.isArray(input)) throw new MachineRequestError(400, 'Send the allowed IPs as a list.', 'For example ["203.0.113.7"].');
  const out = new Set<string>();
  for (const raw of input.slice(0, 11)) {
    const m = IPV4.exec(String(raw).trim());
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255)) {
      throw new MachineRequestError(400, `"${String(raw).slice(0, 60)}" isn’t an IPv4 address.`, 'Use your public IPv4 address, e.g. from: curl -4 ifconfig.me');
    }
    const prefix = m[5] == null ? 32 : Number(m[5]);
    if (prefix < MIN_PREFIX || prefix > 32) {
      throw new MachineRequestError(400, `${m[0]} is too wide.`, `Allow single addresses (or ranges of /${MIN_PREFIX} and narrower), never the whole internet.`);
    }
    // Zero the host bits so the cloud accepts it (e.g. 203.0.113.7/24 → 203.0.113.0/24).
    const n = m.slice(1, 5).reduce((a, o) => a * 256 + Number(o), 0);
    const masked = prefix === 0 ? 0 : Math.floor(n / 2 ** (32 - prefix)) * 2 ** (32 - prefix);
    out.add(`${[24, 16, 8, 0].map((b) => Math.floor(masked / 2 ** b) % 256).join('.')}/${prefix}`);
  }
  if (out.size > 10) throw new MachineRequestError(400, 'At most 10 addresses.', 'Remove some first.');
  return [...out];
}

const SSH_CLOUDS = ['gcp', 'aws'];

async function machineRegions(userId: string, provider: string): Promise<string[]> {
  const r = await query(
    `SELECT DISTINCT region FROM machines WHERE user_id = $1 AND provider = $2 AND status NOT IN ('terminated', 'deleted', 'failed')`,
    [userId, provider],
  );
  return r.rows.map((x: any) => x.region);
}

/** The "dev" user's public keys (normalized "type base64 comment" lines). */
export async function getSshKeys(userId: string): Promise<string[]> {
  const r = await query('SELECT keys FROM dev_ssh_keys WHERE user_id = $1', [userId]);
  return (r.rows[0]?.keys as string[]) || [];
}

/** Replace the keys. Takes the text people paste: one public key per line. */
export async function setSshKeys(userId: string, text: unknown): Promise<string[]> {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /PRIVATE KEY/.test(l))) {
    throw new MachineRequestError(400, 'That’s a PRIVATE key — never paste it anywhere.', 'Paste the public half instead: the .pub file (one line starting with ssh-ed25519 or ssh-rsa). If the private key was shared, make a new key pair.');
  }
  if (lines.length > 10) throw new MachineRequestError(400, 'At most 10 keys.', 'Remove some first.');
  const keys = lines.map((l) => {
    const k = parseSshPublicKey(l);
    if (!k) throw new MachineRequestError(400, `Not a valid SSH public key: "${l.slice(0, 40)}…"`, 'Paste the whole line from the .pub file, exactly as it is (e.g. ssh-ed25519 AAAA… name).');
    return `${k.type} ${k.data}${k.comment ? ` ${k.comment}` : ''}`;
  });
  await query(
    `INSERT INTO dev_ssh_keys (user_id, keys, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET keys = EXCLUDED.keys, updated_at = NOW()`,
    [userId, keys],
  );
  return keys;
}

export async function getSshAccess(userId: string) {
  const connected = new Set((await listCredentialSummaries(userId)).map((c: any) => c.provider));
  const machines = (await query(
    `SELECT id, provider, region, status, ip_address, nickname FROM machines
      WHERE user_id = $1 AND status NOT IN ('terminated', 'deleted', 'failed') ORDER BY created_at`,
    [userId],
  )).rows;
  const clouds = await Promise.all(Object.keys(CATALOGS).filter((p) => connected.has(p)).map(async (provider) => {
    const label = (CATALOGS as any)[provider].label as string;
    if (!SSH_CLOUDS.includes(provider)) return { provider, label, supported: false, cidrs: [] as string[], regions: [] as string[] };
    const regions = await machineRegions(userId, provider);
    try {
      const cidrs = (await (await providerFor(userId, provider)).getSshAccess(regions)) || [];
      return { provider, label, supported: true, cidrs, regions };
    } catch (e: any) {
      return { provider, label, supported: true, cidrs: [] as string[], regions, error: e?.title || e?.message || String(e) };
    }
  }));
  return {
    user: 'dev',
    keys: await getSshKeys(userId),
    clouds,
    machines: machines.map((m: any) => ({ id: m.id, provider: m.provider, region: m.region, status: m.status, ip: m.ip_address, name: m.nickname })),
  };
}

export async function setSshAccess(userId: string, provider: string, cidrsIn: unknown) {
  if (!SSH_CLOUDS.includes(provider)) throw new MachineRequestError(400, 'This cloud can’t open SSH from the app yet.', 'Google Cloud and AWS can.');
  const cidrs = normalizeCidrs(cidrsIn);
  const regions = await machineRegions(userId, provider);
  if (provider === 'aws' && !regions.length && cidrs.length) {
    throw new MachineRequestError(409, 'Launch an AWS machine first.', 'SSH is opened in the firewall of each region you have machines in.');
  }
  await (await providerFor(userId, provider)).setSshAccess(cidrs, regions);
  return { provider, cidrs };
}
