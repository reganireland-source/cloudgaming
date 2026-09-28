/**
 * ============================================================================
 * src/services/InventoryService.ts — EVERYTHING DEPLOYED, ACROSS ALL CLOUDS
 * ============================================================================
 *
 * Feeds the infrastructure map. For one user it:
 *   1. asks each cloud they have keys for what Gints Global Gaming Hubjob created there
 *      (provider.listResources(): machines, disks, snapshots, networks,
 *      firewalls, public IPs...), all clouds in parallel,
 *   2. merges in the app's own machine records (status, name, cost) — and
 *      adds machines the cloud doesn't return (still being created, failed,
 *      or deleted outside the app),
 *   3. flags ORPHANS: things that cost money but aren't attached to anything,
 *      plus machines that exist at the cloud but that the app lost track of,
 *   4. totals the costs: running now ($/hour) and standing ($/month for
 *      disks, snapshots and IPs, billed even when machines are stopped).
 *
 * Cloud answers are cached for 60 seconds per user and cloud, because
 * listing takes a few seconds and the map refreshes often. ?refresh=true
 * skips the cache.
 * ============================================================================
 */

import { query } from '../config/database';
import { toFriendlyError, FriendlyError } from '../providers/errors';
import { CATALOGS, isProviderName } from '../providers/registry';
import type { InventoryItem } from '../providers/shared/types';
import { listCredentialSummaries, providerFor } from './CredentialService';

export interface MapItem extends InventoryItem {
  machineId?: string;        // our machine id, when the item is (or belongs to) a tracked machine
  source: 'cloud' | 'app';   // 'app' = only known from our records (not returned by the cloud)
  /** For snapshots the app made: 'shelf' = it IS a shelved machine; 'backup' = an extra copy. */
  snapshotRole?: 'shelf' | 'backup';
  snapshotRecordId?: string; // our snapshots.id, so the UI can delete it
}

/** Last path segment of a cloud id ("rg/name", "region/ocid", ARM ids…), for matching. */
const tail = (id: string) => String(id || '').split('/').filter(Boolean).pop() || '';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; items?: InventoryItem[]; error?: FriendlyError }>();

async function listFor(userId: string, provider: string, refresh: boolean) {
  const key = `${userId}:${provider}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit;
  let entry: { at: number; items?: InventoryItem[]; error?: FriendlyError };
  try {
    const cloud = await providerFor(userId, provider);
    entry = { at: Date.now(), items: await cloud.listResources() };
  } catch (error) {
    console.error(`[Inventory] ${provider} listing failed:`, (error as Error).message);
    entry = { at: Date.now(), error: toFriendlyError(error, provider, (error as any)?.projectId) };
  }
  cache.set(key, entry);
  return entry;
}

export async function getInventory(userId: string, refresh = false) {
  const creds = await listCredentialSummaries(userId);
  const clouds = creds.map((c) => c.provider).filter(isProviderName);

  // 1. Every cloud in parallel.
  const results = await Promise.all(clouds.map(async (p) => ({ provider: p, ...(await listFor(userId, p, refresh)) })));
  const items: MapItem[] = [];
  const errors: Array<{ provider: string; error: FriendlyError }> = [];
  for (const r of results) {
    if (r.error) errors.push({ provider: r.provider, error: r.error });
    for (const it of r.items || []) items.push({ ...it, source: 'cloud' });
  }

  // 2. Merge the app's machine records.
  const machines = await query(
    `SELECT id, provider, region, instance_type, instance_id, status, cost_per_hour, disk_size_gb, ip_address, spot, game_title, snapshot_id
     FROM machines WHERE user_id = $1`,
    [userId]
  );
  const tracked = new Set<string>();
  for (const m of machines.rows) {
    const vm = items.find((i) => i.type === 'vm' && i.provider === m.provider && i.instanceId === m.instance_id);
    if (vm) {
      tracked.add(`${vm.provider}:${vm.instanceId}`);
      vm.machineId = m.id;
      // The app's status words ('creating', 'deleting'...) are more precise mid-action.
      if (['creating', 'starting', 'stopping', 'deleting', 'shelving', 'restoring'].includes(m.status)) vm.status = m.status;
      vm.hourlyCost = Number(m.cost_per_hour) || vm.hourlyCost;
      vm.name = `${m.instance_type}${m.game_title ? ` · ${m.game_title}` : ''}`;
    } else if (m.status === 'shelved') {
      // Shelved: no machine at the cloud on purpose — only its snapshot
      // (listed separately below). Shown so the map/costs know it exists.
      items.push({
        provider: m.provider, type: 'vm', source: 'app', machineId: m.id,
        id: m.instance_id, instanceId: m.instance_id, name: `${m.instance_type}${m.game_title ? ` · ${m.game_title}` : ''}`,
        region: m.region, status: 'shelved', hourlyCost: 0,
      });
    } else {
      // Known to the app but not (or no longer) at the cloud.
      const cloudListed = results.some((r) => r.provider === m.provider && r.items);
      items.push({
        provider: m.provider, type: 'vm', source: 'app', machineId: m.id,
        id: m.instance_id, instanceId: m.instance_id, name: m.instance_type,
        region: m.region,
        status: String(m.instance_id).startsWith('pending:') ? m.status
          : cloudListed && !['creating', 'deleting'].includes(m.status) ? 'missing' : m.status,
        hourlyCost: Number(m.cost_per_hour) || 0,
      });
    }
    // Resources attached to a tracked machine belong to it.
    for (const it of items) if (it.attachedTo && it.attachedTo === m.instance_id && it.provider === m.provider) it.machineId = m.id;
  }

  // 2b. Snapshots the app made are deliberate, not leftovers — even when the
  //     disk they came from is gone (that's what shelving does).
  const snaps = await query('SELECT id, machine_id, provider, snapshot_provider_id, snapshot_data FROM snapshots WHERE user_id = $1', [userId]);
  const shelfOf = new Map(machines.rows.filter((m: any) => m.snapshot_id && ['shelved', 'shelving', 'restoring'].includes(m.status)).map((m: any) => [m.snapshot_id, m.id]));
  for (const it of items) {
    if (it.type !== 'snapshot') continue;
    const rec = snaps.rows.find((r: any) => r.provider === it.provider && [r.snapshot_provider_id, ...Object.values(r.snapshot_data || {}).map((d: any) => d?.id)]
      .some((sid: string) => sid && tail(sid) === tail(it.id)));
    if (!rec) continue;
    it.snapshotRecordId = rec.id;
    it.orphan = false;
    it.orphanReason = undefined;
    const shelfMachine = shelfOf.get(rec.id);
    it.snapshotRole = shelfMachine ? 'shelf' : 'backup';
    it.machineId = shelfMachine || rec.machine_id || it.machineId;
  }

  // 3. Machines at the cloud that the app doesn't track: they still bill.
  for (const it of items) {
    if (it.type === 'vm' && it.source === 'cloud' && !tracked.has(`${it.provider}:${it.instanceId}`)) {
      it.orphan = true;
      it.orphanReason = it.status === 'running'
        ? 'Machine running at the cloud but not tracked by the app (record deleted?) — billing by the hour'
        : 'Machine at the cloud not tracked by the app — its disk is still billed';
    }
  }

  // 4. Totals.
  const running = items.filter((i) => i.type === 'vm' && i.status === 'running');
  const hourly = running.reduce((s, i) => s + (i.hourlyCost || 0), 0);
  const monthly = items.reduce((s, i) => s + (i.monthlyCost || 0), 0);
  const orphans = items.filter((i) => i.orphan);
  const byCloud = Object.fromEntries(clouds.map((p) => {
    const mine = items.filter((i) => i.provider === p);
    return [p, {
      label: CATALOGS[p].label,
      items: mine.length,
      machines: mine.filter((i) => i.type === 'vm').length,
      running: mine.filter((i) => i.type === 'vm' && i.status === 'running').length,
      hourly: round(mine.filter((i) => i.type === 'vm' && i.status === 'running').reduce((s, i) => s + (i.hourlyCost || 0), 0)),
      monthly: round(mine.reduce((s, i) => s + (i.monthlyCost || 0), 0)),
    }];
  }));

  return {
    generatedAt: new Date().toISOString(),
    clouds,
    items,
    errors,
    totals: {
      runningMachines: running.length,
      hourly: round(hourly),
      monthlyStanding: round(monthly),
      orphans: orphans.length,
      orphanMonthly: round(orphans.reduce((s, i) => s + (i.monthlyCost || 0), 0)),
      orphanHourly: round(orphans.filter((i) => i.status === 'running').reduce((s, i) => s + (i.hourlyCost || 0), 0)),
    },
    byCloud,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
