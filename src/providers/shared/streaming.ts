/**
 * src/providers/shared/streaming.ts — network settings every cloud needs
 * for game streaming.
 *
 * Sunshine (the streaming server on the machine) and Moonlight (the app you
 * play on) talk over these ports, so each cloud's firewall (GCP firewall
 * rule, AWS security group, Azure network security group, Oracle security
 * list) must allow them in from the internet. 47990 is Sunshine's
 * password-protected web admin page (used once, to pair Moonlight).
 *
 * Browser access (no app to install), both HTTPS with the machine's login:
 *   48200/tcp        KasmVNC — "Use the desktop" in a browser tab
 *   48300/tcp        Moonlight Web — "Play in browser" (experimental)
 *   40000-40030/udp  Moonlight Web's WebRTC video/audio/input
 * Existing firewalls get new ports added on the next launch in that
 * project/region (each cloud's ensure-firewall step reconciles).
 */
export const BROWSER_PORTS = { kasmvnc: 48200, moonlightWeb: 48300, webrtcFrom: 40000, webrtcTo: 40030 };
export const SUNSHINE_TCP_PORTS = ['47984', '47989', '47990', '48010', String(BROWSER_PORTS.kasmvnc), String(BROWSER_PORTS.moonlightWeb)];
export const SUNSHINE_UDP_PORTS = ['47998-48000', '48002', '48010', `${BROWSER_PORTS.webrtcFrom}-${BROWSER_PORTS.webrtcTo}`];

/** Same ports as numeric ranges, for clouds whose APIs want from/to numbers. */
export const SUNSHINE_PORT_RANGES: Array<{ protocol: 'tcp' | 'udp'; from: number; to: number }> = [
  { protocol: 'tcp', from: 47984, to: 47984 },
  { protocol: 'tcp', from: 47989, to: 47990 },
  { protocol: 'tcp', from: 48010, to: 48010 },
  { protocol: 'udp', from: 47998, to: 48000 },
  { protocol: 'udp', from: 48002, to: 48002 },
  { protocol: 'udp', from: 48010, to: 48010 },
  // Browser access — appended at the END: Azure rule priorities follow this order.
  { protocol: 'tcp', from: BROWSER_PORTS.kasmvnc, to: BROWSER_PORTS.kasmvnc },
  { protocol: 'tcp', from: BROWSER_PORTS.moonlightWeb, to: BROWSER_PORTS.moonlightWeb },
  { protocol: 'udp', from: BROWSER_PORTS.webrtcFrom, to: BROWSER_PORTS.webrtcTo },
];

/** Name used for the firewall / security group / tag on every cloud. */
export const STREAMING_FIREWALL_NAME = 'cloudgaming-sunshine';

/** Label/tag put on everything we create, so it's easy to find in a console. */
export const RESOURCE_TAG = { key: 'app', value: 'cloudgaming-hub' };
