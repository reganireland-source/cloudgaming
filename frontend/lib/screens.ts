/**
 * lib/screens.ts — STREAM IN THE SHAPE OF YOUR SCREEN
 *
 * Sunshine (via CloudyPad's screen-mode script) builds a virtual screen of
 * whatever size Moonlight asks for, so any shape works: MacBook 16:10 or the
 * taller full-notch sizes, 21:9 and 32:9 ultrawides, 3:2 and 4:3 tablets.
 * One hard limit: datacenter GPUs (T4, L4, A10G, A10) can't drive a headless
 * screen bigger than 2560×1600 (an NVIDIA driver limit), so the machine
 * shrinks larger requests to fit, keeping the shape. We ask for that fitted
 * size directly, so the stream is exactly your screen's shape and Moonlight
 * scales it to fill the display — no black bars, no stretching.
 */

export interface ScreenPreset {
  id: string;
  label: string;
  group: string;
  /** The display's native pixels (its shape; also the most we'd ever ask for). */
  w: number;
  h: number;
}

export const MAX_W = 2560;
export const MAX_H = 1600;
/** EXPERIMENTAL big-screen machines (GRID driver): up to 4096x2160. */
export const GRID_MAX = { w: 4096, h: 2160 };

export const SCREENS: ScreenPreset[] = [
  { id: '16x9', label: 'Standard 16:9 (most monitors & TVs)', group: 'Common', w: 3840, h: 2160 },
  { id: '16x10', label: '16:10 laptop / monitor (1920×1200, 2560×1600)', group: 'Common', w: 2560, h: 1600 },

  { id: 'mac-notch-safe', label: 'MacBook with a notch — full screen below the notch (16:10)', group: 'MacBook (M1–M5)', w: 3024, h: 1890 },
  { id: 'mbp14', label: 'MacBook Pro 14″ — whole screen incl. notch area (3024×1964)', group: 'MacBook (M1–M5)', w: 3024, h: 1964 },
  { id: 'mbp16', label: 'MacBook Pro 16″ — whole screen incl. notch area (3456×2234)', group: 'MacBook (M1–M5)', w: 3456, h: 2234 },
  { id: 'mba13', label: 'MacBook Air 13″ M2–M5 — whole screen incl. notch area (2560×1664)', group: 'MacBook (M1–M5)', w: 2560, h: 1664 },
  { id: 'mba15', label: 'MacBook Air 15″ — whole screen incl. notch area (2880×1864)', group: 'MacBook (M1–M5)', w: 2880, h: 1864 },
  { id: 'mac-no-notch', label: 'MacBook Air M1 / MacBook Pro 13″ (2560×1600, 16:10)', group: 'MacBook (M1–M5)', w: 2560, h: 1600 },

  { id: 'uw-2560', label: 'Ultrawide 21:9 — 2560×1080', group: 'Ultrawide', w: 2560, h: 1080 },
  { id: 'uw-3440', label: 'Ultrawide 21:9 — 3440×1440', group: 'Ultrawide', w: 3440, h: 1440 },
  { id: 'uw-3840', label: 'Ultrawide 24:10 — 3840×1600', group: 'Ultrawide', w: 3840, h: 1600 },
  { id: 'suw-3840', label: 'Super ultrawide 32:9 — 3840×1080', group: 'Ultrawide', w: 3840, h: 1080 },
  { id: 'suw-5120', label: 'Super ultrawide 32:9 — 5120×1440', group: 'Ultrawide', w: 5120, h: 1440 },

  { id: '3x2', label: '3:2 laptop (Surface, Framework 13) — 2256×1504', group: 'Tablets & handhelds', w: 2256, h: 1504 },
  { id: 'ipad-4x3', label: 'iPad 4:3 (iPad Pro 13″ M4 2752×2064, iPad 2048×1536)', group: 'Tablets & handhelds', w: 2752, h: 2064 },
  { id: 'ipad-11', label: 'iPad Pro / Air 11″ — 2388×1668', group: 'Tablets & handhelds', w: 2388, h: 1668 },
  { id: 'steamdeck', label: 'Steam Deck — 1280×800', group: 'Tablets & handhelds', w: 1280, h: 800 },
  { id: 'phone', label: 'Phone, landscape ~19.5:9 — 2532×1170', group: 'Tablets & handhelds', w: 2532, h: 1170 },
];

const down8 = (n: number) => Math.max(8, Math.floor(n / 8) * 8);

/**
 * The resolution to ask for: the screen's shape, with about as many pixels
 * as the quality preset (e.g. 1440p ≈ 3.7 MP), never more than the screen
 * itself or the GPU's 2560×1600 box. Multiples of 8 (what the machine's
 * screen-mode tool rounds to anyway, so request and stream match exactly).
 */
export function fitResolution(screen: { w: number; h: number }, presetPixels: number, maxW = MAX_W, maxH = MAX_H): { w: number; h: number } {
  const aspect = screen.w / screen.h;
  let h = Math.sqrt(Math.min(presetPixels, screen.w * screen.h) / aspect);
  let w = h * aspect;
  if (w > maxW) { w = maxW; h = w / aspect; }
  if (h > maxH) { h = maxH; w = h * aspect; }
  // Width to a multiple of 8, then the height that best keeps the shape.
  const W = down8(w);
  const H = Math.min(down8(maxH), Math.max(8, Math.round(W / aspect / 8) * 8));
  return { w: W, h: H };
}

/** This browser window's screen in real pixels (e.g. 3024×1964 on a 14″ MacBook Pro), or null. */
export function detectScreen(): { w: number; h: number } | null {
  if (typeof window === 'undefined' || !window.screen?.width) return null;
  const dpr = window.devicePixelRatio || 1;
  const a = Math.round(window.screen.width * dpr);
  const b = Math.round(window.screen.height * dpr);
  return { w: Math.max(a, b), h: Math.min(a, b) }; // landscape
}

export interface AttachedScreen { key: string; label: string; w: number; h: number; primary: boolean; current: boolean }

/**
 * Every display attached to this computer, via the browser's Window
 * Management API (Chrome/Edge 100+). The browser asks once for permission
 * ("Manage windows on all your displays"); with `ask` false we only read
 * the list when that was already granted, so nothing pops up on page load.
 * Returns null where the API doesn't exist (Safari, Firefox) or permission
 * was refused — then only the window's own screen is known (detectScreen).
 */
export async function detectAllScreens(ask: boolean): Promise<AttachedScreen[] | null> {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  if (!w?.getScreenDetails) return null;
  if (!ask) {
    try {
      const st = await navigator.permissions.query({ name: 'window-management' as PermissionName });
      if (st.state !== 'granted') return null;
    } catch { return null; }
  }
  try {
    const details = await w.getScreenDetails();
    return (details.screens as any[]).map((sc, i) => {
      const dpr = sc.devicePixelRatio || 1;
      const a = Math.round(sc.width * dpr);
      const b = Math.round(sc.height * dpr);
      return {
        key: `${i}:${a}x${b}`,
        label: sc.label || (sc.isInternal ? 'Built-in display' : `Display ${i + 1}`),
        w: Math.max(a, b), h: Math.min(a, b),
        primary: !!sc.isPrimary,
        current: sc === details.currentScreen,
      };
    });
  } catch {
    return null; // permission refused
  }
}

/** Can this browser list every display? (Offer the "find my other screens" button.) */
export const canListScreens = () => typeof window !== 'undefined' && 'getScreenDetails' in window;
