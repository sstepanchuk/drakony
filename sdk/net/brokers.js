// MQTT transport: one connection per public broker, all at once. Liveness checks, backoff, and dropping
// copies of a message that arrived through several brokers. What messages mean is up to room.js,
// which receives them through N.onConnected(client) and N.onMessage(msg, client).
//
// The connections are managed here rather than by the MQTT library, so behaviour is predictable:
// - each broker connects on its own; a failed one is retried later and later (up to two minutes);
// - a connection that is still being set up is never restarted (browsers report minor network changes
//   often, and restarting on each of them used to break joining a room);
// - while no broker works at all, retries are frequent: the problem is probably our own network.
import { BROKERS, MQTT_LIB, me, SENDER } from './config.js';

const SENDERS = 16;                                    // how many senders the duplicate filter remembers
const TD = new TextDecoder();
let mqttLib = null;

// The MQTT client library, loaded once from a CDN (with a fallback), checked against its pinned hash.
export function loadTransport() {
  if (window.mqtt) return Promise.resolve();
  if (mqttLib) return mqttLib;
  mqttLib = new Promise((res, rej) => {
    const tryUrl = i => {
      if (window.mqtt) return res();
      if (i >= MQTT_LIB.urls.length) { mqttLib = null; return rej(new Error('mqtt')); }
      const s = document.createElement('script');
      s.integrity = MQTT_LIB.integrity; s.crossOrigin = 'anonymous';
      s.src = MQTT_LIB.urls[i];
      s.onload = () => (window.mqtt ? res() : tryUrl(i + 1));
      s.onerror = () => tryUrl(i + 1);
      document.head.appendChild(s);
    };
    tryUrl(0);
  });
  return mqttLib;
}

export function openBrokers(N) {
  N.br = BROKERS.map(() => ({ state: 'connecting', since: 0, fails: 0, timer: null }));
  N.clients = []; N.win = BROKERS.map(() => 0);
  BROKERS.forEach((b, i) => openBroker(N, i));
}

export function closeBrokers(N) {
  for (const st of N.br) { clearTimeout(st.timer); st.timer = null; }
  for (const c of N.clients) { try { if (c) c.end(true); } catch (e) {} }
}

function openBroker(N, i) {
  const B = BROKERS[i], st = N.br[i];
  clearTimeout(st.timer); st.timer = null;
  st.state = 'connecting'; st.since = performance.now();
  const o = { clientId: 'ih-' + me + '-' + i + '-' + Date.now().toString(36), clean: true, keepalive: 15, reconnectPeriod: 0, connectTimeout: 8000 };
  if (B.user) { o.username = B.user; o.password = B.pass; }
  let c;
  try { c = window.mqtt.connect(B.url, o); } catch (e) { N.clients[i] = null; retryBroker(N, i); return; }
  c._ok = false; c._echo = false; c._lat = null; c._rx = performance.now();
  N.clients[i] = c;
  c.on('connect', () => {
    if (N.closed || N.clients[i] !== c) return;
    c.subscribe(N.topic, { qos: 0 }, err => {
      if (N.closed || N.clients[i] !== c) return;
      if (err) { retryBroker(N, i); return; }
      c._ok = true; c._rx = performance.now();
      st.state = 'ok'; st.fails = 0;
      N.onConnected(c);
      pubOn(N, { t: 'k', ts: performance.now() });     // measure at once how fast this broker is
    });
  });
  c.on('message', (t, p) => { if (!N.closed && N.clients[i] === c) { c._rx = performance.now(); onRaw(N, p, c); } });
  c.on('close', () => { c._ok = false; if (!N.closed && N.clients[i] === c) retryBroker(N, i); });
  c.on('error', () => {});
}

// the broker did not answer or the connection dropped: close it and try again after a growing pause
function retryBroker(N, i) {
  const st = N.br[i];
  if (st.timer) return;
  const old = N.clients[i];
  N.clients[i] = null;
  try { if (old) old.end(true); } catch (e) {}
  st.state = 'wait'; st.fails++;
  const anyOk = N.clients.some(c => c && c._ok);
  const base = Math.min(anyOk ? 120000 : 2500, 1000 * Math.pow(2, Math.min(st.fails - 1, 7)));
  st.timer = setTimeout(() => { st.timer = null; if (!N.closed) openBroker(N, i); }, base * (.75 + Math.random() * .5));
}

// the same, but right now (after a network change there is nothing to wait for)
function rebuildBroker(N, i) {
  const st = N.br[i], old = N.clients[i];
  clearTimeout(st.timer); st.timer = null;
  N.clients[i] = null;
  try { if (old) old.end(true); } catch (e) {}
  openBroker(N, i);
}

// check every broker now, without waiting for timeouts → false if it was checked a moment ago
export function kickBrokers(N) {
  const t0 = performance.now();
  if (t0 - N.kickAt < 3000) return false;
  N.kickAt = t0;
  N.br.forEach((st, i) => {
    if (st.state === 'wait') { st.fails = Math.min(st.fails, 1); rebuildBroker(N, i); }   // waiting for a retry: retry now
    else if (st.state === 'connecting' && t0 - st.since > 5000) rebuildBroker(N, i);      // stuck while connecting
  });
  pubOn(N, { t: 'k', ts: t0 });                        // a live broker echoes this back at once
  setTimeout(() => {
    if (N.closed) return;
    N.clients.forEach((c, i) => { if (c && c._ok && c._echo && c._rx < t0) rebuildBroker(N, i); });
  }, 2500);
  return true;
}

// periodic upkeep (from the watchdog): echo test, forget old broker scores, restart stuck connections
export function tendBrokers(N, now) {
  if (now - N.winAt > 2000) { N.winAt = now; for (let i = 0; i < N.win.length; i++) N.win[i] *= .5; }
  if (now - N.kAt > 5000) {
    N.kAt = now;
    pubOn(N, { t: 'k', ts: now });
    N.clients.forEach((c, i) => { if (c && c._ok && c._echo && now - c._rx > 12000) rebuildBroker(N, i); });
    N.br.forEach((st, i) => { if (st.state === 'connecting' && now - st.since > 10000) retryBroker(N, i); });
  }
}

export const brokerDiag = N => {
  const now = performance.now();
  return N.br.map((st, i) => BROKERS[i].name + ': ' + (st.state === 'ok' ? 'ok ' + (N.clients[i]._lat == null ? '?' : Math.round(N.clients[i]._lat) + ' ms')
    : st.state === 'wait' ? 'down' : now - st.since > 3500 ? 'not answering' : 'connecting')).join(', ');
};

// to every broker at once (the receiver drops the copies by sequence number)
export function pubOn(N, obj) {
  obj.f = me; obj.q = ++N.seq;
  const s = JSON.stringify(obj);
  for (const c of N.clients) if (c && c._ok) { try { c.publish(N.topic, s, { qos: 0 }); } catch (e) {} }
}

// Game data goes to two brokers, not all four. Which two the other player tells us: they see which broker
// delivers our packets first. Until they do, we take the two that answer us fastest. Every 24th message
// goes through all of them, so the other side can keep comparing.
export function pubData(N, obj) {
  obj.f = me; obj.q = ++N.seq;
  const s = JSON.stringify(obj), cl = N.clients;
  const live = [];
  for (let i = 0; i < cl.length; i++) if (cl[i] && cl[i]._ok) live.push(i);
  let to = live;
  if (++N.pubN % 24 !== 0) {
    to = [];
    if (performance.now() - N.peerBestAt < 6000) for (const i of N.peerBest) if (live.includes(i)) to.push(i);
    live.sort((a, b) => (cl[a]._lat == null ? 1e9 : cl[a]._lat) - (cl[b]._lat == null ? 1e9 : cl[b]._lat));
    for (const i of live) { if (to.length >= 2) break; if (!to.includes(i)) to.push(i); }
  }
  // data goes to the sender's own "mailbox": the broker does not echo it back, which halves the traffic
  for (const i of to) { try { cl[i].publish(N.topic + '/d/' + me, s, { qos: 0 }); } catch (e) {} }
}

// the two brokers that deliver the other player's data to us first
export function bestBrokers(N) {
  const idx = [];
  for (let i = 0; i < N.win.length; i++) if (N.win[i] > .5) idx.push(i);
  return idx.sort((a, b) => N.win[b] - N.win[a]).slice(0, 2);
}

function onRaw(N, p, c) {
  const str = typeof p === 'string' ? p : TD.decode(p);
  // Quick check before parsing: every message ends with …"f":"sender","q":number}. A copy already seen
  // through another broker is dropped without spending time on JSON.parse.
  const qi = str.lastIndexOf('"q":'), fi = str.lastIndexOf('"f":"', qi);
  if (qi > 0 && fi > 0) {
    const f = str.slice(fi + 5, str.indexOf('"', fi + 5));
    if (f !== me) { const w = N.last.get(f); if (w && w.set.has(parseInt(str.slice(qi + 4), 10))) return; }
  }
  let m;
  try { m = JSON.parse(str); } catch (e) { return; }
  // anyone can publish to a public topic: drop whatever does not look like one of our messages
  if (!m || typeof m !== 'object' || typeof m.f !== 'string' || !SENDER.test(m.f) || typeof m.t !== 'string') return;
  if (m.f === me) {                                    // our own echo: the broker is alive; measure how fast it is
    c._echo = true;
    if (m.t === 'k' && typeof m.ts === 'number') { const d = performance.now() - m.ts; c._lat = c._lat == null ? d : c._lat * .7 + d * .3; }
    return;
  }
  if (m.to && m.to !== me) return;
  if (typeof m.q === 'number') {                       // the same message may come through two brokers: keep the first
    let w = N.last.get(m.f);
    if (w) N.last.delete(m.f);                         // a recent sender moves to the end of the queue
    else {
      w = { set: new Set(), ring: new Float64Array(256), at: 0 };
      if (N.last.size >= SENDERS) N.last.delete(N.last.keys().next().value);   // the oldest sender is forgotten
    }
    N.last.set(m.f, w);
    if (w.set.has(m.q)) return;
    if (w.set.size === 256) w.set.delete(w.ring[w.at]);   // the oldest number makes room for the new one
    w.set.add(m.q); w.ring[w.at] = m.q; w.at = (w.at + 1) & 255;
  }
  try { N.onMessage(m, c); } catch (e) { console.error(e); }   // one odd message must not break the connection
}
