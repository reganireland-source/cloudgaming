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
  gpu: string;            // our model id: T4, L4, A10G, A10
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
};

/** Tier → the consumer range its GPUs cover. */
export const TIER_CONSUMER: Record<string, string> = {
  good: '≈ GTX 1070',
  better: '≈ RTX 3060 Ti–3070',
  best: '≈ RTX 3070 + more CPU',
};
