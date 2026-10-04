/**
 * lib/gpuCompare.ts — "WHAT GAMING CARD IS THIS ROUGHLY LIKE?"
 *
 * Cloud GPUs are datacenter cards: lower clocks and power limits, more
 * memory, no monitor output (we stream a virtual screen), server drivers.
 * These are rough gaming equivalents from public benchmarks of the same
 * chips, to give an idea only; real results vary by game, resolution and
 * CPU (cloud vCPUs are server cores, usually slower per core than a
 * gaming PC's).
 */

export interface GpuCompare {
  gpu: string;            // our model id: T4, L4, A10G, A10, L40S, RTX PRO 6000
  chip: string;           // architecture / die
  vram: string;
  power: string;          // board power limit
  consumer: string;       // ≈ gaming card
  short: string;          // for tight spaces
  vs3080Ti: string;       // share of an RTX 3080 Ti (a common reference point)
  clouds: string;
}

export const GPU_COMPARE: Record<string, GpuCompare> = {
  T4: { gpu: 'T4', chip: 'Turing TU104', vram: '16 GB', power: '70 W', consumer: 'GTX 1070 / GTX 1660 Super', short: '≈ GTX 1070', vs3080Ti: '~30%', clouds: 'AWS g4dn · Google N1+T4 · Azure NCasT4_v3' },
  L4: { gpu: 'L4', chip: 'Ada AD104', vram: '24 GB', power: '72 W', consumer: 'RTX 3060 Ti / RTX 4060 Ti', short: '≈ RTX 3060 Ti', vs3080Ti: '~55%', clouds: 'Google G2' },
  A10G: { gpu: 'A10G', chip: 'Ampere GA102', vram: '24 GB', power: '150 W', consumer: 'RTX 3070', short: '≈ RTX 3070', vs3080Ti: '~65%', clouds: 'AWS g5' },
  A10: { gpu: 'A10', chip: 'Ampere GA102', vram: '24 GB', power: '150 W', consumer: 'RTX 3070 (a little faster than the A10G)', short: '≈ RTX 3070', vs3080Ti: '~70%', clouds: 'Oracle VM.GPU.A10' },
  // SUPER tier: full-size graphics chips with DLSS 3 / 4 frame generation.
  L40S: { gpu: 'L40S', chip: 'Ada AD102', vram: '48 GB', power: '350 W', consumer: 'RTX 4080 Super – RTX 4090 (DLSS 3 frame generation)', short: '≈ RTX 4080 Super', vs3080Ti: '~140%', clouds: 'AWS g6e' },
  'RTX PRO 6000': { gpu: 'RTX PRO 6000', chip: 'Blackwell GB202', vram: '96 GB', power: '600 W', consumer: 'RTX 5090 (DLSS 4 multi-frame generation)', short: '≈ RTX 5090', vs3080Ti: '~210%', clouds: 'Google G4' },
};

/** Tier → the consumer range its GPUs cover. */
export const TIER_CONSUMER: Record<string, string> = {
  good: '≈ GTX 1070',
  better: '≈ RTX 3060 Ti–3070',
  best: '≈ RTX 3070 + more CPU',
  super: '≈ RTX 4080 Super–5090 · DLSS FG',
};

/** Tier → DLSS features its GPUs support (games still have to support them). */
export const TIER_DLSS: Record<string, string> = {
  good: 'DLSS 2 upscaling',
  better: 'DLSS 2 upscaling (L4: DLSS 3 frame generation)',
  best: 'DLSS 2 upscaling',
  super: 'DLSS 3 frame generation (L40S) · DLSS 4 multi-frame generation (RTX PRO 6000)',
};
