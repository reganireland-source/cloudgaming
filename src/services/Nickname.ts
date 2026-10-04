/**
 * services/Nickname.ts — A MACHINE'S NICKNAME
 *
 * Default: CLOUD-CITY-GPU-TIER, plus -S for spot and -BS for big screen,
 * e.g. GOOGLE-SINGAPORE-L4-BEST-S-BS. Editable; shown in the app and
 * announced by Sunshine (what Moonlight lists). Letters, digits, spaces,
 * dot, dash and underscore only, up to 40 characters (it ends up inside
 * shell scripts and YAML, so nothing that could be interpreted).
 */

import { query } from '../config/database';
import { CATALOGS, isProviderName } from '../providers/registry';
import { NICKNAME_RE } from '../providers/shared/setupScript';
import { tierOf } from './ReconService';

const CLOUD_WORD: Record<string, string> = { gcp: 'GOOGLE', aws: 'AWS', azure: 'AZURE', oracle: 'ORACLE' };

/** "Querétaro (Mexico)" → "QUERETARO", "N. Virginia" → "N-VIRGINIA". */
function cityWord(regionName: string): string {
  return regionName.replace(/\(.*?\)/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'REGION';
}

export function defaultNickname(m: { provider: string; region: string; instanceType: string; spot: boolean; bigScreen: boolean }): string {
  const catalog = isProviderName(m.provider) ? CATALOGS[m.provider] : null;
  const region = catalog?.regions.find((r) => r.id === m.region);
  const shape = catalog?.shapes.find((s) => s.id === m.instanceType);
  const parts = [
    CLOUD_WORD[m.provider] || m.provider.toUpperCase(),
    cityWord(region?.name || m.region),
    shape?.gpuModel.toUpperCase().replace(/\s+/g, '') || 'GPU',   // RTX PRO 6000 → RTXPRO6000
    shape ? tierOf(shape).toUpperCase() : '',
    m.spot ? 'S' : '',
    m.bigScreen ? 'BS' : '',
  ].filter(Boolean);
  let name = parts.join('-');
  // Keep within 40 characters: shorten the city first.
  if (name.length > 40) {
    const over = name.length - 40;
    parts[1] = parts[1].slice(0, Math.max(3, parts[1].length - over));
    name = parts.join('-').slice(0, 40);
  }
  return name;
}

/** Clean up a user-typed nickname; null if it isn't acceptable. */
export function cleanNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return NICKNAME_RE.test(s) ? s : null;
}

/** Make the name unique among the user's machines (adds -2, -3…). */
export async function uniqueNickname(userId: string, base: string, exceptMachineId?: string): Promise<string> {
  const rows = (await query('SELECT nickname FROM machines WHERE user_id = $1 AND id <> $2 AND nickname IS NOT NULL',
    [userId, exceptMachineId || '00000000-0000-0000-0000-000000000000'])).rows;
  const taken = new Set(rows.map((r: any) => String(r.nickname).toUpperCase()));
  if (!taken.has(base.toUpperCase())) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
  return base;
}
