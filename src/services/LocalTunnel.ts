/**
 * ============================================================================
 * src/services/LocalTunnel.ts: SSH TO A LOCAL PC THROUGH GGGH
 * ============================================================================
 *
 * No router changes, works behind a shared internet address. Two WebSockets
 * are joined end to end:
 *
 *   your computer (ssh + a small helper)  --wss-->  GGGH  <--wss--  the PC's agent --> its own SSH server
 *
 * 1. The helper dials /api/local-agent/ssh-client with the PC's launcher token.
 * 2. GGGH asks the agent (the command queue) to dial /api/local-agent/tunnel/<id>.
 * 3. The agent opens a TCP connection to localhost:22 on the PC and relays bytes.
 * GGGH only relays encrypted SSH bytes; the PC's SSH server still decides who
 * gets in (keys). The tunnel is for SSH only: Moonlight's video is far too heavy.
 * ============================================================================
 */

import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { sshTunnelRequest, tunnelAgentMachine } from './LocalMachineService';

const CLIENT_PATH = '/api/local-agent/ssh-client';
const AGENT_PATH = '/api/local-agent/tunnel/';
const AGENT_WAIT_MS = 25_000;
const MAX_PER_MACHINE = 5;

interface Pending { machineId: string; client: WebSocket; agent?: WebSocket; queued: Array<{ data: RawData; binary: boolean }>; timer: NodeJS.Timeout }
const sessions = new Map<string, Pending>();

const bearer = (req: IncomingMessage) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
function refuse(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message.replace(/[\r\n]/g, ' ')}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function end(sid: string, code = 1000, reason = '') {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  clearTimeout(s.timer);
  for (const w of [s.client, s.agent]) { try { if (w && w.readyState <= WebSocket.OPEN) w.close(code, reason.slice(0, 120)); } catch { /* already gone */ } }
}

export function attachLocalTunnel(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url || '').split('?')[0];
    if (path === CLIENT_PATH) {
      sshTunnelRequest(bearer(req)).then((r) => {
        if (!r.ok) return refuse(socket, r.status, r.message);
        const open = [...sessions.values()].filter((s) => s.machineId === r.machineId).length;
        if (open >= MAX_PER_MACHINE) return refuse(socket, 429, 'Too many SSH connections open to this PC.');
        wss.handleUpgrade(req, socket, head, (client) => {
          const s: Pending = { machineId: r.machineId, client, queued: [], timer: setTimeout(() => end(r.sid, 1011, 'The PC did not answer in time.'), AGENT_WAIT_MS) };
          sessions.set(r.sid, s);
          client.on('message', (data, binary) => {
            if (s.agent && s.agent.readyState === WebSocket.OPEN) s.agent.send(data, { binary });
            else if (s.queued.length < 200) s.queued.push({ data, binary });
          });
          client.on('close', () => end(r.sid));
          client.on('error', () => end(r.sid));
        });
      }).catch(() => refuse(socket, 500, 'Try again shortly.'));
      return;
    }
    if (path.startsWith(AGENT_PATH)) {
      const sid = path.slice(AGENT_PATH.length);
      tunnelAgentMachine(bearer(req)).then((machineId) => {
        const s = sessions.get(sid);
        if (!machineId || !s || s.machineId !== machineId || s.agent) return refuse(socket, 403, 'No such tunnel.');
        wss.handleUpgrade(req, socket, head, (agent) => {
          s.agent = agent;
          clearTimeout(s.timer);
          for (const q of s.queued) agent.send(q.data, { binary: q.binary });
          s.queued = [];
          agent.on('message', (data, binary) => { if (s.client.readyState === WebSocket.OPEN) s.client.send(data, { binary }); });
          agent.on('close', () => end(sid));
          agent.on('error', () => end(sid));
        });
      }).catch(() => refuse(socket, 500, 'Try again shortly.'));
    }
  });
}
