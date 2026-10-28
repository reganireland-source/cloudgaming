/**
 * src/providers/shared/purposes.ts: "WHAT IS THIS MACHINE FOR?"
 *
 * A purpose is a starting point for the launch form that sets BOTH the machine
 * (the kind of size, disk) and the software (add-ons from addons.ts). The form
 * applies it and everything stays editable. A purpose adds no new rules on the
 * server: the launch still validates the machine and add-ons it is sent.
 *
 * size.* are requirements the form filters sizes by; the "Size" choice
 * (light / standard / heavy) picks the cheapest, a middle or the most capable
 * size that meets them in the chosen region.
 */

export interface PurposeToggle { id: string; label: string; help?: string; default: boolean; addons: string[] }
export interface Purpose {
  id: string;
  name: string;
  blurb: string;
  size: { minVcpus?: number; minMemoryGb?: number; devTier?: boolean };
  diskGb: number;
  /** Always installed for this purpose. */
  addons: string[];
  toggles: PurposeToggle[];
  quality?: string;
}

export const PURPOSES: Purpose[] = [
  { id: 'play', name: 'Play games', blurb: 'A gaming PC you stream to. Nothing extra installed.',
    size: {}, diskGb: 0, addons: [], toggles: [] },
  { id: 'gamedev', name: 'Game development & testing', blurb: 'Build, run headless tests and smoke-test Windows builds. Many cores, bigger disk.',
    size: { minVcpus: 8, devTier: true }, diskGb: 200, addons: ['dev-base', 'github-cli', 'headless-gpu'],
    toggles: [
      { id: 'godot', label: 'Godot', default: true, addons: ['godot'] },
      { id: 'wine', label: 'Run Windows builds (Wine + DXVK)', default: true, addons: ['wine'] },
      { id: 'python', label: 'Python tools', default: true, addons: ['python'] },
      { id: 'media', label: 'Audio / video tools', default: false, addons: ['media-tools'] },
    ] },
  { id: 'unity', name: 'Unity builds', blurb: 'Unity Editor for command-line builds. Large disk; the install is experimental and you activate the licence.',
    size: { minVcpus: 8, minMemoryGb: 32, devTier: true }, diskGb: 300, addons: ['dev-base', 'github-cli', 'headless-gpu', 'unity'],
    toggles: [
      { id: 'python', label: 'Python tools', default: false, addons: ['python'] },
      { id: 'node', label: 'Node.js', default: false, addons: ['node'] },
    ] },
  { id: 'dev', name: 'General development', blurb: 'Compilers, git, Python and Node for builds, scripts and CI-style jobs.',
    size: { minVcpus: 4 }, diskGb: 100, addons: ['dev-base', 'github-cli'],
    toggles: [
      { id: 'python', label: 'Python', default: true, addons: ['python'] },
      { id: 'node', label: 'Node.js', default: true, addons: ['node'] },
      { id: 'browser', label: 'Headless browser (Playwright)', default: false, addons: ['browser-test'] },
    ] },
  { id: 'content', name: '3D & media processing', blurb: 'Blender, ffmpeg and Python for model, texture, audio and video jobs.',
    size: { minVcpus: 4 }, diskGb: 150, addons: ['dev-base', 'media-tools', 'blender'],
    toggles: [
      { id: 'python', label: 'Python', default: true, addons: ['python'] },
      { id: 'github', label: 'GitHub CLI', default: false, addons: ['github-cli'] },
    ] },
];
