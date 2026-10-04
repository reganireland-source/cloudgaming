/**
 * lib/nickname.ts — the default machine name, as the backend makes it
 * (src/services/Nickname.ts): CLOUD-CITY-GPU-TIER, plus -S for spot and
 * -BS for big screen, e.g. GOOGLE-SINGAPORE-L4-BEST-S-BS or AWS-TOKYO-L40S-SUPER. Shown as the
 * launch form's suggestion; the backend has the final say (and adds -2 if
 * you already have a machine with that name).
 */

const CLOUD_WORD: Record<string, string> = { gcp: 'GOOGLE', aws: 'AWS', azure: 'AZURE', oracle: 'ORACLE' };

const tierOf = (gpuModel: string, vcpus: number) => (gpuModel === 'L40S' || gpuModel === 'RTX PRO 6000' ? 'SUPER'
  : gpuModel === 'T4' ? 'GOOD' : gpuModel === 'A10' ? 'BEST' : vcpus >= 8 ? 'BEST' : 'BETTER');

export function defaultNickname(m: { provider: string; regionName: string; gpuModel?: string; vcpus?: number; spot: boolean; bigScreen: boolean }): string {
  const city = m.regionName.replace(/\(.*?\)/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'REGION';
  const parts = [CLOUD_WORD[m.provider] || m.provider.toUpperCase(), city, m.gpuModel?.toUpperCase().replace(/\s+/g, '') || 'GPU',
    m.gpuModel ? tierOf(m.gpuModel, m.vcpus || 0) : '', m.spot ? 'S' : '', m.bigScreen ? 'BS' : ''].filter(Boolean);
  let name = parts.join('-');
  if (name.length > 40) { parts[1] = parts[1].slice(0, Math.max(3, parts[1].length - (name.length - 40))); name = parts.join('-').slice(0, 40); }
  return name;
}

/** What the backend accepts. */
export const NICKNAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
