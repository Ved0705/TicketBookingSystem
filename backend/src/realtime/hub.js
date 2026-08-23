import { WebSocketServer } from 'ws';

/**
 * Very small pub/sub hub over WebSockets.
 *
 * Clients connect to  ws://host/ws?showId=123  and receive JSON frames:
 *   { type: 'seats.updated', showId, seats: [{ id, status }], at }
 *   { type: 'waitlist.offer', showId, userId, offerId, ... }
 *
 * State changes are published from the service layer *after* the database
 * transaction commits, so the broadcast can never describe a state the
 * database does not actually hold.
 */
const roomsByShow = new Map(); // showId -> Set<ws>
let wss = null;

export function attachWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let showId = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      const raw = url.searchParams.get('showId');
      if (raw && Number.isInteger(Number(raw))) showId = Number(raw);
    } catch {
      /* ignore malformed query */
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (showId !== null) join(ws, showId);

    ws.on('message', (buf) => {
      // Allows a client to switch shows without reconnecting.
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'subscribe' && Number.isInteger(Number(msg.showId))) {
          if (showId !== null) leave(ws, showId);
          showId = Number(msg.showId);
          join(ws, showId);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });

    ws.on('close', () => { if (showId !== null) leave(ws, showId); });
    ws.send(JSON.stringify({ type: 'connected', showId }));
  });

  const ping = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, 30000);
  ping.unref?.();

  return wss;
}

function join(ws, showId) {
  if (!roomsByShow.has(showId)) roomsByShow.set(showId, new Set());
  roomsByShow.get(showId).add(ws);
}

function leave(ws, showId) {
  const room = roomsByShow.get(showId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) roomsByShow.delete(showId);
}

export function publishToShow(showId, payload) {
  const room = roomsByShow.get(Number(showId));
  if (!room || room.size === 0) return 0;
  const frame = JSON.stringify({ ...payload, showId: Number(showId), at: new Date().toISOString() });
  let sent = 0;
  for (const ws of room) {
    if (ws.readyState === 1) { ws.send(frame); sent += 1; }
  }
  return sent;
}

/** Broadcast a set of seat status changes for one show. */
export function publishSeatUpdates(showId, seats, reason) {
  if (!seats || seats.length === 0) return 0;
  return publishToShow(showId, { type: 'seats.updated', reason, seats });
}

export function closeWebSocket() {
  if (!wss) return;
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  wss = null;
  roomsByShow.clear();
}

export function connectionCount() {
  return wss ? wss.clients.size : 0;
}
