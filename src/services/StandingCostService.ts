/**
 * ============================================================================
 * src/services/StandingCostService.ts — WHAT BILLS WHILE YOU AREN'T PLAYING
 * ============================================================================
 *
 * "Standing cost" = money charged every month whether or not any machine is
 * running: disks (kept while a machine is stopped), snapshots, reserved IPs
 * and leftovers. This service lists every such item across all clouds, with
 * its $/month and one piece of advice:
 *
 *   ok    in use, or already the cheapest way to keep it (a shelved machine)
 *   save  could be cheaper: a machine stopped for days (→ Shelve), an extra
 *         backup its machine doesn't need (→ delete the snapshot)
 *   waste costs money for nothing: a leftover disk/IP/snapshot not attached
 *         to anything the app knows (→ delete it in the cloud console)
 *
 * Built from the live inventory (what the clouds report). If a cloud can't be
 * read right now, its disks/snapshots are estimated from the app's own
 * records instead and marked `estimated`.
 * ============================================================================
 */

import { query } from '../config/database';
import { CATALOGS } from '../providers/registry';
import { getInventory } from './InventoryService';

type Level = 'ok' | 'save' | 'waste';
type Action = 'shelve' | 'restore' | 'delete-snapshot' | 'console' | 'machine';

export interface StandingItem {
  key: string;
  provider: string;
  region: string;
  kind: 'disk' | 'snapshot' | 'ip' | 'other';
  name: string;
  sizeGb?: number;
  monthlyCost: number;
  machineId?: string;
  machineLabel?: string;
  machineStatus?: string;
  stoppedDays?: number;
  autoShelveDays?: number | null;
  snapshotRecordId?: string;
  estimated?: boolean;
  consoleUrl?: string;
  advice: { level: Level; text: string; action?: Action; saving?: { low: number; high: number } };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const KIND: Record<string, StandingItem['kind']> = { disk: 'disk', snapshot: 'snapshot', 'public-ip': 'ip' };

export async function getStandingCosts(userId: string, refresh = false) {
  const inv = await getInventory(userId, refresh);
  const machines = (await query(
    `SELECT m.id, m.provider, m.region, m.instance_type, m.instance_id, m.status, m.disk_size_gb, m.game_title,
            m.stopped_at, m.auto_shelve_days, m.snapshot_id, s.stored_gb
     FROM machines m LEFT JOIN snapshots s ON s.id = m.snapshot_id WHERE m.user_id = $1`, [userId])).rows;
  const byId = new Map(machines.map((m: any) => [m.id, m]));
  // Clouds whose live listing we have; everything else is estimated from our records.
  const failed = new Set(inv.errors.map((e) => e.provider));
  const listed = new Set(inv.clouds.filter((p) => !failed.has(p)));
  const now = Date.now();
  const label = (m: any) => `${m.instance_type}${m.game_title ? ` · ${m.game_title}` : ''}`;
  const days = (m: any) => (m?.stopped_at ? Math.floor((now - new Date(m.stopped_at).getTime()) / 86_400_000) : undefined);

  /** Advice for a disk that belongs to machine m (or to nothing). */
  const diskAdvice = (m: any, monthly: number, sizeGb: number): StandingItem['advice'] => {
    if (!m) return { level: 'waste', text: 'Leftover disk — not attached to any machine the app knows. It bills every month for nothing.', action: 'console' };
    if (m.status === 'stopped') {
      const c = CATALOGS[m.provider as keyof typeof CATALOGS];
      const low = r2(monthly - sizeGb * c.snapshotPerGbMonth);                 // snapshot of a full disk
      const high = r2(monthly - Math.min(30, sizeGb) * c.snapshotPerGbMonth);  // snapshot of a fresh install
      const d = days(m) ?? 0;
      const auto = m.auto_shelve_days ? ` Auto-shelve is on: it will be shelved after ${m.auto_shelve_days} day${m.auto_shelve_days === 1 ? '' : 's'} stopped.` : '';
      return {
        level: d >= 2 ? 'save' : 'ok',
        text: `Machine stopped${d ? ` for ${d} day${d === 1 ? '' : 's'}` : ''}: its whole disk is billed, empty space included. Not playing for a week or more? Shelve it.${auto}`,
        action: 'shelve', saving: { low: Math.max(0, low), high: Math.max(0, high) },
      };
    }
    if (['shelving', 'restoring', 'deleting', 'stopping', 'starting', 'creating'].includes(m.status)) return { level: 'ok', text: `Machine is ${m.status}.`, action: 'machine' };
    return { level: 'ok', text: 'Disk of a running machine — part of what you pay while playing.', action: 'machine' };
  };

  const items: StandingItem[] = [];
  for (const it of inv.items) {
    const monthly = Number(it.monthlyCost) || 0;
    if (!monthly || it.type === 'vm') continue;
    const m = it.machineId ? byId.get(it.machineId) : undefined;
    const base = {
      key: `${it.provider}:${it.type}:${it.id}`, provider: it.provider, region: it.region, kind: KIND[it.type] || 'other' as const,
      name: it.name, sizeGb: it.sizeGb, monthlyCost: r2(monthly), machineId: m?.id, machineLabel: m ? label(m) : undefined,
      machineStatus: m?.status, stoppedDays: days(m), autoShelveDays: m?.auto_shelve_days ?? null,
      snapshotRecordId: it.snapshotRecordId, consoleUrl: it.consoleUrl,
    };
    let advice: StandingItem['advice'];
    if (it.type === 'disk') advice = it.orphan ? diskAdvice(undefined, monthly, it.sizeGb || 0) : diskAdvice(m, monthly, it.sizeGb || Number(m?.disk_size_gb) || 0);
    else if (it.type === 'snapshot') {
      advice = it.snapshotRole === 'shelf'
        ? { level: 'ok', text: 'Shelved machine — the cheapest way to keep your games. Restore it to play.', action: 'restore' }
        : it.snapshotRole === 'backup'
          ? (m && m.status !== 'shelved'
            ? { level: 'save', text: 'Extra backup: its machine still has its own disk, so this is a second bill. Keep it only if you want a restore point.', action: 'delete-snapshot', saving: { low: r2(monthly), high: r2(monthly) } }
            : { level: 'save', text: 'Backup of a machine that no longer exists. Delete it unless you plan to restore from it.', action: 'delete-snapshot', saving: { low: r2(monthly), high: r2(monthly) } })
          : { level: 'waste', text: it.orphanReason || 'Snapshot the app doesn\'t track — still billed every month.', action: 'console' };
    } else {
      advice = it.orphan
        ? { level: 'waste', text: it.orphanReason || 'Leftover — not attached to anything; billed every month.', action: 'console' }
        : { level: 'ok', text: m ? 'Part of this machine.' : 'Shared network piece used by your machines.' };
    }
    items.push({ ...base, advice });
  }

  // Clouds that couldn't be read (or have no keys saved any more): estimate
  // from our records so nothing is hidden.
  for (const m of machines) {
    if (listed.has(m.provider)) continue;
    const c = CATALOGS[m.provider as keyof typeof CATALOGS];
    if (!c) continue;
    const diskGb = Number(m.disk_size_gb) || c.defaultDiskGb;
    // Any state in which the machine (and so its disk) still exists at the cloud.
    if (['running', 'stopped', 'starting', 'stopping', 'unknown', 'shelving', 'restoring'].includes(m.status) && !/^(pending|shelved):/.test(String(m.instance_id))) {
      const monthly = r2(diskGb * c.diskPerGbMonth);
      items.push({ key: `est:${m.id}:disk`, provider: m.provider, region: m.region, kind: 'disk', name: `Disk of ${label(m)}`, sizeGb: diskGb, monthlyCost: monthly,
        machineId: m.id, machineLabel: label(m), machineStatus: m.status, stoppedDays: days(m), autoShelveDays: m.auto_shelve_days ?? null, estimated: true,
        advice: diskAdvice(m, monthly, diskGb) });
    } else if (m.status === 'shelved') {
      const gb = Number(m.stored_gb) || diskGb;
      items.push({ key: `est:${m.id}:snap`, provider: m.provider, region: m.region, kind: 'snapshot', name: `Snapshot of ${label(m)}`, sizeGb: gb, monthlyCost: r2(gb * c.snapshotPerGbMonth),
        machineId: m.id, machineLabel: label(m), machineStatus: m.status, snapshotRecordId: m.snapshot_id, estimated: true,
        advice: { level: 'ok', text: 'Shelved machine — the cheapest way to keep your games. Restore it to play.', action: 'restore' } });
    }
  }

  const backups = (await query(
    `SELECT s.id, s.provider, s.region, s.disk_size_gb, s.stored_gb, s.machine_id FROM snapshots s
     WHERE s.user_id = $1 AND NOT EXISTS (SELECT 1 FROM machines m WHERE m.snapshot_id = s.id AND m.status IN ('shelved', 'shelving', 'restoring'))`, [userId])).rows;
  for (const b of backups) {
    if (listed.has(b.provider)) continue;
    const c = CATALOGS[b.provider as keyof typeof CATALOGS];
    if (!c) continue;
    const gb = Number(b.stored_gb) || Number(b.disk_size_gb) || c.defaultDiskGb;
    const monthly = r2(gb * c.snapshotPerGbMonth);
    const m = b.machine_id ? byId.get(b.machine_id) : undefined;
    items.push({ key: `est:snap:${b.id}`, provider: b.provider, region: b.region, kind: 'snapshot', name: 'Backup snapshot', sizeGb: gb, monthlyCost: monthly,
      machineId: m?.id, machineLabel: m ? label(m) : undefined, machineStatus: m?.status, snapshotRecordId: b.id, estimated: true,
      advice: m ? { level: 'save', text: 'Extra backup: its machine still has its own disk, so this is a second bill. Keep it only if you want a restore point.', action: 'delete-snapshot', saving: { low: monthly, high: monthly } }
        : { level: 'save', text: 'Backup of a machine that no longer exists. Delete it unless you plan to restore from it.', action: 'delete-snapshot', saving: { low: monthly, high: monthly } } });
  }

  const ORDER: Record<Level, number> = { waste: 0, save: 1, ok: 2 };
  items.sort((a, b) => ORDER[a.advice.level] - ORDER[b.advice.level] || b.monthlyCost - a.monthlyCost);
  const sum = (list: StandingItem[]) => r2(list.reduce((s, i) => s + i.monthlyCost, 0));
  return {
    generatedAt: new Date().toISOString(),
    errors: inv.errors,
    items,
    totals: {
      monthly: sum(items),
      disks: sum(items.filter((i) => i.kind === 'disk')),
      snapshots: sum(items.filter((i) => i.kind === 'snapshot')),
      other: sum(items.filter((i) => i.kind === 'ip' || i.kind === 'other')),
      waste: sum(items.filter((i) => i.advice.level === 'waste')),
      savingLow: r2(items.filter((i) => i.advice.level !== 'ok').reduce((s, i) => s + (i.advice.saving?.low ?? (i.advice.level === 'waste' ? i.monthlyCost : 0)), 0)),
      savingHigh: r2(items.filter((i) => i.advice.level !== 'ok').reduce((s, i) => s + (i.advice.saving?.high ?? (i.advice.level === 'waste' ? i.monthlyCost : 0)), 0)),
    },
    // Per-cloud rates, for the "stopped vs shelved" comparison.
    rates: Object.values(CATALOGS).map((c) => ({ provider: c.provider, label: c.label, diskPerGbMonth: c.diskPerGbMonth, snapshotPerGbMonth: c.snapshotPerGbMonth, defaultDiskGb: c.defaultDiskGb, restoreAnyRegion: c.restoreAnyRegion })),
  };
}
