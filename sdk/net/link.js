// Delivery between the two players over two paths: direct (WebRTC) and through the brokers. Each path's
// ping is measured on its own and all the time; messages take the faster one. Usually that is the direct
// path, but a "direct" link through a far-away TURN relay can be slower than the brokers.
//
// Messages are plain objects with a string `t` ('p', 'q' and 'bye' are the link's own). Reliable ones get a
// number `_x` and run exactly once even when they arrive by both paths; fast ones (no `_x`) may be lost or
// reordered — the game numbers them itself if it cares.
import { BROKERS } from './servers.js';
import { bestBrokers, brokerDiag, pubData } from './brokers.js';
import { dcLive, dcFresh, dcHear } from './rtc.js';

const RX_WINDOW = 512;                                 // how many reliable message numbers we remember

// a new other player (or the same person in a new tab): measurements and numbering start over
export function resetPaths(N) {
  N.tx = 0; N.rxSet = new Set(); N.rxMax = 0; N.pts = -1; N.byePts = -1; N.suspect = -1e9;
  N.rD = N.rR = null; N.sD = []; N.sR = []; N.qD = N.qR = -1; N.slowDirect = false; N.peerRtt = null;
}

/* ---------- sending ---------- */
// fast: unordered, may be lost (state, aim); batch: through the brokers, wait up to 45 ms for two more
export function send(N, m, { fast = false, batch = false } = {}) {
  if (N.closed || !N.linked) return;
  if (!fast) m._x = ++N.tx;
  if (dcLive(N) && N.via === 'p2p') {
    try { (fast ? N.dcF : N.dcC).send(JSON.stringify(m)); } catch (e) {}
    if (dcFresh(N)) return;                            // the direct link is alive: that is enough
  }
  // through the brokers (no direct path, it went quiet, or it is slower)
  N.q.push(m);
  if (!batch || N.q.length >= 3) flushRelay(N);
  else if (!N.qTimer) N.qTimer = setTimeout(() => flushRelay(N), 45);
}
export function sendDirect(N, m) { if (dcLive(N)) { try { N.dcF.send(JSON.stringify(m)); } catch (e) {} } }
export function sendRelay(N, m) { if (N.linked) { N.q.push(m); flushRelay(N); } }
export function flushRelay(N) {
  clearTimeout(N.qTimer); N.qTimer = null;
  if (!N.q.length || !N.other) return;
  const d = N.q; N.q = [];
  if (!N.closed) pubData(N, { t: 'd', to: N.other, d });
}

/* ---------- receiving ---------- */
export function deliver(N, m, viaRelay) {
  if (N.closed || !N.linked || !m || typeof m !== 'object' || typeof m.t !== 'string') return;
  const now = performance.now();
  N.lastSeen = now;
  if (m.t === 'bye') { N.byeFrom(false); return; }     // the other player closed the tab
  let isNew = true;                                    // has this not already come by the other path?
  const x = m._x;
  if (x === undefined) {                               // fast: the game filters its own; here only the pulse
    if (m.t === 'p') { isNew = Number.isFinite(m.ts) && m.ts > N.pts; if (isNew) N.pts = m.ts; }
  } else {                                             // reliable: exactly once. Numbers only grow, so anything
    if (!Number.isInteger(x) || x <= N.rxMax - RX_WINDOW || N.rxSet.has(x)) return;   // older than the window is a replay
    delete m._x;
    N.rxSet.add(x);
    if (x > N.rxMax) N.rxMax = x;
    if (N.rxSet.size > 2 * RX_WINDOW) for (const x of N.rxSet) if (x <= N.rxMax - RX_WINDOW) N.rxSet.delete(x);
  }
  if (m.r === 1) N.suspect = now;                      // the other player says they cannot hear us directly
  if (m.t === 'p') {                                   // pulse and ping
    if (!Number.isFinite(m.ts)) return;
    const q = { t: 'q', ts: m.ts };
    if (viaRelay) sendRelay(N, q); else sendDirect(N, q);   // answer by the same path, so each path is measured on its own
    if (!isNew) return;                                // the copy from the other path was already counted
    if (N.byeAt && m.ts > N.byePts) N.byeAt = 0;       // a new pulse after a goodbye: they are back (not a late packet)
    if (typeof m.rt === 'number' && m.rt >= 0 && m.rt < 5000) N.peerRtt = m.rt;
    if (Array.isArray(m.w)) { N.peerBest = m.w.filter(i => Number.isInteger(i) && i >= 0 && i < BROKERS.length).slice(0, 2); N.peerBestAt = now; }
    if (m.g && typeof m.g === 'object') N.emit('pulse', m.g);
    return;
  }
  if (m.t === 'q') {
    if (!Number.isFinite(m.ts)) return;
    const rtt = now - m.ts;
    if (rtt < 0 || rtt > 5000) return;
    if (viaRelay) {                                    // the answer came through the brokers: that path's ping
      if (m.ts <= N.qR) return;
      N.qR = m.ts; N.sR.push(rtt); if (N.sR.length > 7) N.sR.shift(); N.rR = med(N.sR);
    } else {                                           // it came through the direct link: the direct path's ping
      if (m.ts <= N.qD) return;
      N.qD = m.ts; N.sD.push(rtt); if (N.sD.length > 7) N.sD.shift(); N.rD = med(N.sD);
    }
    return;
  }
  N.emit('message', m);
}

/* ---------- ping and path choice ---------- */
const med = a => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null;
// round trip of the path in use
export const curRtt = N => N.via === 'p2p' ? (N.rD != null ? N.rD : N.rR) : (N.rR != null ? N.rR : N.rD);
// round trip to show: on the direct path the browser's own network measurement (unaffected by how busy the page is)
export const netRtt = N => { const r = curRtt(N); return r != null && N.via === 'p2p' && N.iceRtt != null ? Math.min(r, N.iceRtt + 1) : r; };

// One-way delay estimate: half the round trip of the path in use. On the direct path the browser's own
// network measurement is used when smaller: what needs evening out is the network, not a busy phone.
export function lag(N) {
  let r = N.linked ? curRtt(N) : null;
  if (r == null) return 0;
  if (N.via === 'p2p' && N.iceRtt != null) r = Math.min(r, N.iceRtt + 12);
  return Math.min(300, r / 2);
}

export function pickRoute(N) {
  if (!dcFresh(N)) return 'relay';                     // no direct path, or it went quiet
  if (N.rD == null || N.rR == null) return 'p2p';
  if (N.slowDirect) { if (N.rD <= N.rR + 10) N.slowDirect = false; }      // back to direct as soon as it is not worse
  else if (N.rR + 30 < N.rD * .8) N.slowDirect = true;                    // the brokers are clearly faster: use them
  return N.slowDirect ? 'relay' : 'p2p';
}

// what the game may show: ping both ways and whether the link is direct
export function stats(N) {
  const rtt = N.linked && !N.weak ? netRtt(N) : null;
  return { rtt: rtt == null ? null : Math.round(rtt), peerRtt: N.peerRtt, direct: N.via === 'p2p', relayed: N.via !== 'p2p' || N.turn === true, turn: N.turn };
}
// choose the path again and tell the game (event 'stats')
export function refresh(N) {
  N.via = pickRoute(N); N.viaAt = performance.now();
  N.emit('stats', stats(N));
}

// Detailed connection state for bug reports (not shown to players).
export function diag(N) {
  const f = v => v == null ? '—' : Math.round(v) + ' ms';
  const used = N.via === 'p2p' ? (N.turn ? 'direct link through a TURN relay' : N.turn === false ? 'direct' : 'direct link') : 'brokers';
  return ['path: ' + used + (N.slowDirect ? ' (direct link exists but is slower)' : ''),
    'direct ping: ' + f(N.rD) + ' (browser: ' + f(N.iceRtt) + '), candidates: ' + (N.cand || '—'),
    'broker ping: ' + f(N.rR),
    'brokers: ' + brokerDiag(N),
    'they hear us best through: ' + (N.peerBest.map(i => BROKERS[i].name).join(', ') || '—'),
    'we hear them best through: ' + (bestBrokers(N).map(i => BROKERS[i].name).join(', ') || '—'),
    'role: ' + (N.role || '—') + ', direct link open: ' + (dcLive(N) ? 'yes' : 'no') + ', hearing through it: ' + (dcHear(N) ? 'yes' : 'no')
  ].join('\n');
}
