// @ihroteka/net — two-player rooms for library games. Public MQTT brokers find the other player and carry
// the game when nothing better works; a direct WebRTC link takes over when it can. No server of our own.
// The API is described in README.md ("Multiplayer").
//
// Room protocol: whoever came first is the host (the game usually runs the authoritative simulation
// there), the second is the guest. Roles settle themselves: if both think they are first, the "greater"
// id gives way. Messages on the room topic: who (anyone here?), host (I hold the room), full,
// hello (guest → host), hi (host → guest: linked), moved (another tab of yours took your seat),
// bye (left; final if menu=1), rtc (direct link signalling), d (game data through the brokers).
import { me, samePlayer, roomTopic } from './config.js';
import { closeBrokers, loadTransport, openBrokers, pubOn } from './brokers.js';
import { closeRtc, onRtc } from './rtc.js';
import { deliver, send, lag, stats, diag, refresh, resetPaths, watch, setWeak, kick, keepDirectAlive } from './link.js';

export { newRoomCode, validRoomCode } from './config.js';
// start loading the transport early (e.g. while the player is still in the menu); never throws
export const preload = () => { loadTransport().catch(() => {}); };

const BYE_GRACE = 5000, ABANDONED = 15000;           // when a seat may go to someone else (see seatFree)
const RESERVED = new Set(['p', 'q', 'bye']);          // message types the link itself uses (link.js)

/**
 * Join (or open) a two-player room.
 *   game       short id of the game: rooms of different games never meet
 *   code       room code (see newRoomCode / validRoomCode)
 *   lostAfter  ms of silence before the other player counts as gone (default 60 s; 90 s while room.patient())
 * Returns the room at once; it connects in the background and reports through events.
 */
export function joinRoom({ game, code, lostAfter = 60000 }) {
  const ev = emitter();
  const N = {
    game, code, lostAfter, emit: ev.emit, closed: false,
    // brokers (brokers.js); seq starts from the clock, so numbers of a new connection never collide with what
    // the other player remembers from our previous one
    topic: '', clients: [], br: [], seq: Date.now(), last: new Map(), ready: false, kickAt: -1e9, kAt: 0,
    heard: null, win: [], winAt: 0, peerBest: [], peerBestAt: -1e9, pubN: 0,
    // who is who
    role: null, other: null, linked: false, weak: false, byeAt: 0, lastSeen: 0, lastWatch: performance.now(), graceUntil: 0,
    // paths, numbering and ping (link.js)
    via: 'relay', viaAt: 0, q: [], qTimer: null, pingAt: 0, pN: 0, nudged: 0,
    // direct link (rtc.js)
    pc: null, dcF: null, dcC: null, dcSeen: 0, dcBorn: 0, iceQ: [], rtcK: null, rtcNext: 0, rtcTries: 0, turn: null, cand: '', iceRtt: null, statsAt: 0,
    // timers
    whoTimer: null, annTimer: null, helloTimer: null, rtcTimer: null, failTimer: null, fullTimer: null, watchTimer: null
  };
  resetPaths(N);

  const room = {
    get code() { return code; },
    get role() { return N.role; },                     // null while looking around, then 'host' or 'guest' ('out' when replaced)
    get linked() { return N.linked; },                 // both players are here and hear each other
    get weak() { return N.weak; },                     // the other player went quiet (or said bye and may come back)
    get leaving() { return !!N.byeAt; },               // they closed their tab; their seat is held for 20 s
    get direct() { return N.via === 'p2p'; },
    // The game's policy (replace these functions):
    keepSeat: () => false,                             // a round is on: hold the seat when the other player closes the tab
    patient: () => false,                              // the game is paused: allow a longer silence
    streaming: () => false,                            // the other player streams state every frame (the direct link counts as dead sooner)
    pulse: null,                                       // (now) => object: extra fields for the pulse sent 5 times a second
    on(name, fn) { ev.on(name, fn); return room; },
    send(msg, opts) {                                  // { fast, batch }: see link.js
      if (!msg || typeof msg.t !== 'string' || RESERVED.has(msg.t)) throw new Error('@ihroteka/net: a message needs a string t other than ' + [...RESERVED].join(', '));
      send(N, msg, opts);
    },
    lag: () => lag(N),                                 // one-way delay estimate, ms
    stats: () => stats(N),                             // { rtt, peerRtt, direct, relayed, turn }
    diag: () => diag(N),                               // multi-line connection report
    frame: now => keepDirectAlive(N, now),             // optional, every animation frame: notices a silent direct link sooner
    kick: () => kick(N),                               // the network changed or the page became visible
    leave() {                                          // final: tell the other player and disconnect
      if (N.closed) return;
      N.closed = true; N.linked = false;
      try { pubOn(N, { t: 'bye', menu: 1 }); } catch (e) {}
      stop(N, 'whoTimer', 'annTimer', 'helloTimer', 'failTimer', 'fullTimer', 'qTimer', 'watchTimer');
      closeRtc(N);
      closeBrokers(N);
      removeEventListener('pagehide', onPageHide);
      removeEventListener('online', room.kick);
      try { navigator.connection.removeEventListener('change', onConnection); } catch (e) {}
    }
  };
  Object.assign(N, {
    keepSeat: () => safe(room.keepSeat), streaming: () => safe(room.streaming), patient: () => safe(room.patient),
    pulse: now => { try { return room.pulse && room.pulse(now); } catch (e) { console.error(e); return null; } },
    refresh: () => refresh(N), peerGone: () => peerGone(N), byeFrom: final => byeFrom(N, final)
  });

  // closing the tab: say goodbye by every path we still can
  const onPageHide = () => {
    if (N.closed) return;
    try { if (N.linked) send(N, { t: 'bye' }); } catch (e) {}
    try { pubOn(N, { t: 'bye' }); } catch (e) {}
  };
  // Browsers report a network change even when they only refined a speed estimate: react only when the
  // network type really changed (Wi-Fi ↔ mobile) or we have no connection anyway.
  let kind = navigator.connection && navigator.connection.type;
  const onConnection = () => {
    const changed = navigator.connection.type !== kind;
    kind = navigator.connection.type;
    if (changed || !N.ready || N.weak) room.kick();
  };
  addEventListener('pagehide', onPageHide);
  addEventListener('online', room.kick);
  try { navigator.connection.addEventListener('change', onConnection); } catch (e) {}

  (async () => {
    await null;                                        // let the caller subscribe to events first
    if (N.closed) return;
    ev.emit('status', 'connecting');
    try { await loadTransport(); } catch (e) { if (!N.closed) ev.emit('status', 'unavailable'); return; }
    N.topic = await roomTopic(game, code);
    if (N.closed) return;
    N.onConnected = c => connected(N, c);
    N.onMessage = (m, c) => onMessage(N, m, c);
    openBrokers(N);
    N.failTimer = setTimeout(() => { if (!N.closed && !N.ready) ev.emit('status', 'no-signal'); }, 6000);
    N.watchTimer = setInterval(() => watch(N), 200);
  })();
  return room;
}

// A tiny event emitter. A throwing listener is reported and does not stop the others
// (nor the network code that emitted the event).
function emitter() {
  const handlers = new Map();
  return {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return this; },
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) { try { fn(...args); } catch (e) { console.error(e); } }
    }
  };
}

// timeouts and intervals share one id space, so clearTimeout stops either
const stop = (N, ...timers) => { for (const k of timers) { clearTimeout(N[k]); N[k] = null; } };
const dropQueue = N => { N.q = []; stop(N, 'qTimer'); };

const pub = (N, obj) => { if (!N.closed) pubOn(N, obj); };

// a broker just connected: bring it up to date with what is going on in the room
function connected(N, c) {
  if (N.other && N.linked) { try { c.subscribe(N.topic + '/d/' + N.other, { qos: 0 }); } catch (e) {} }
  if (!N.ready) { N.ready = true; clearTimeout(N.failTimer); discover(N); }
  else if (N.role === null) pub(N, { t: 'who' });               // still looking: ask on this broker too
  else if (N.role === 'host' && !N.linked) pub(N, { t: 'host' }); // waiting for the guest: announce here too
}

// The seat can go to someone else only when its owner really left: closed the tab a few seconds ago or has
// been silent for long. A short hiccup does not free it (the same person in a new tab is another matter).
const seatFree = N => { const now = performance.now(); return (!!N.byeAt && now - N.byeAt > BYE_GRACE) || now - N.lastSeen > ABANDONED; };

function onMessage(N, m, c) {
  const from = m.f;
  switch (m.t) {
    case 'who':                                        // someone came in and asks whether anyone is here
      if (N.role === 'host') {
        const free = !N.linked || from === N.other || samePlayer(from, N.other) || seatFree(N);
        pub(N, { t: free ? 'host' : 'full', to: from });
      } else if (N.role === 'guest' && N.linked && samePlayer(from, N.other)) {
        pub(N, { t: 'moved', to: N.other });           // the host's old tab should leave quietly
        peerGone(N);                                   // the host came back in a new tab: we hold the room now
        pub(N, { t: 'host', to: from });
      } else if (N.role === null && me < from) { becomeHost(N); pub(N, { t: 'host', to: from }); }
      break;
    case 'host':                                       // someone holds the room
      if (N.linked && from === N.other) {              // the player we are linked with thinks they are alone: they forgot us
        dropPeer(N);
        if (N.role === 'guest') becomeGuest(N, from);  // ask to join them again
        else { becomeHost(N); pub(N, { t: 'host', to: from }); }   // two hosts: settled as usual
        break;
      }
      if (N.role === 'guest' && N.linked && from !== N.other && samePlayer(from, N.other)) peerGone(N);   // our host came back in a new tab
      if (N.role === null || (N.role === 'guest' && !N.linked && N.other !== from)) becomeGuest(N, from);
      else if (N.role === 'host' && !N.linked) {       // two players both think they are first: the "greater" id gives way
        if (from < me) becomeGuest(N, from); else pub(N, { t: 'host', to: from });
      }
      break;
    case 'full':
      if (N.linked || N.role === 'host' || N.role === 'out') break;
      N.emit('status', 'full');
      stop(N, 'whoTimer', 'helloTimer', 'fullTimer');
      N.fullTimer = setTimeout(() => { if (!N.closed && !N.linked) discover(N); }, 2000);
      break;
    case 'hello':                                      // the guest says hello
      if (N.role !== 'host') break;
      if (!N.linked) { N.other = from; pub(N, { t: 'hi', to: from }); linkUp(N); }
      else if (from === N.other) pub(N, { t: 'hi', to: from });
      else if (samePlayer(from, N.other) || seatFree(N)) relink(N, from);   // the same player in a new tab, or someone taking a seat that was left
      else pub(N, { t: 'full', to: from });
      break;
    case 'hi':
      if (N.role === 'guest' && N.other === from && !N.linked) linkUp(N);
      break;
    case 'moved':                                      // another tab of the same player took our seat
      if (from === N.other) leaveQuietly(N);
      break;
    case 'd':                                          // game data through the brokers
      if (N.linked && from === N.other && Array.isArray(m.d)) {
        const ci = N.clients.indexOf(c);               // this broker delivered first: it scores a point
        if (ci >= 0) N.win[ci] = (N.win[ci] || 0) + 1;
        for (const x of m.d) deliver(N, x, true);
      }
      break;
    case 'rtc':
      if (N.linked && from === N.other) onRtc(N, m);
      break;
    case 'bye':
      if (from === N.other) byeFrom(N, !!m.menu);
      break;
  }
}

function setRole(N, role) {
  N.role = role;
  N.emit('role', role);
}

// is anyone in the room? if nobody answers, we are first
function discover(N) {
  stop(N, 'whoTimer', 'annTimer', 'helloTimer');
  N.other = null;
  setRole(N, null);
  pub(N, { t: 'who' });
  setTimeout(() => { if (!N.closed && N.role === null) pub(N, { t: 'who' }); }, 450);
  N.whoTimer = setTimeout(() => { if (!N.closed && N.role === null) becomeHost(N); }, 1100);
}

function becomeHost(N) {
  stop(N, 'whoTimer', 'annTimer', 'helloTimer');
  N.other = null;
  setRole(N, 'host');
  N.emit('status', 'waiting');
  const ann = () => { if (!N.closed && N.role === 'host' && !N.linked) pub(N, { t: 'host' }); };
  ann();
  N.annTimer = setInterval(ann, 2500);
}

function becomeGuest(N, host) {
  stop(N, 'whoTimer', 'annTimer', 'helloTimer');
  N.other = host;
  setRole(N, 'guest');
  N.emit('status', 'joining');
  let tries = 0;
  const hello = () => {
    if (N.closed || N.linked || N.role !== 'guest') { clearInterval(N.helloTimer); return; }
    if (++tries > 6) { clearInterval(N.helloTimer); discover(N); return; }   // no answer: look around again
    pub(N, { t: 'hello', to: host });
  };
  hello();
  N.helloTimer = setInterval(hello, 1200);
}

function linkUp(N) {                                   // both players are here
  N.linked = true;
  listenTo(N, N.other);
  stop(N, 'annTimer', 'helloTimer');
  N.lastSeen = performance.now();
  N.weak = false; N.byeAt = 0; N.rtcTries = 0; N.rtcNext = performance.now() + 300;
  resetPaths(N);
  N.emit('status', 'ready');
  refresh(N);
  N.emit('linked');
}

// listen to this player's data "mailbox" (and stop listening to the previous one)
function listenTo(N, id) {
  if (N.heard === id) return;
  for (const c of N.clients) if (c && c._ok) {
    try { if (N.heard) c.unsubscribe(N.topic + '/d/' + N.heard); } catch (e) {}
    try { if (id) c.subscribe(N.topic + '/d/' + id, { qos: 0 }); } catch (e) {}
  }
  N.heard = id;
}

// The other player said goodbye. If they just closed the tab in the middle of a round, their seat (and the
// round) is held for 20 seconds: maybe it was a reload or an accident. Leaving to the menu is final.
function byeFrom(N, final) {
  if (!N.linked) return;
  if (final || N.role !== 'host' || !N.keepSeat()) { peerGone(N); return; }
  N.byeAt = performance.now(); N.byePts = N.pts;      // a pulse newer than this means they came back
  closeRtc(N);
  setWeak(N, true);
}
function safe(fn) { try { return !!fn(); } catch (e) { return false; } }

// The guest came back in a new tab (or someone took a seat that was left). The round is not reset:
// the game sends the new tab a full picture and goes on after a short countdown.
function relink(N, from) {
  const old = N.other;
  if (old && old !== from) pub(N, { t: 'moved', to: old });
  closeRtc(N);
  dropQueue(N);
  N.other = from; N.byeAt = 0;
  listenTo(N, from);
  N.rtcTries = 0;
  resetPaths(N);
  N.lastSeen = performance.now();
  pub(N, { t: 'hi', to: from });
  N.emit('relinked');
  if (N.weak) setWeak(N, false);
  refresh(N);
}

// another tab of ours took the seat: leave the game quietly and stop looking for the room
function leaveQuietly(N) {
  N.linked = false;
  N.weak = false;
  stop(N, 'whoTimer', 'annTimer', 'helloTimer', 'fullTimer');
  listenTo(N, null);                                   // and no longer take in the host's data stream
  closeRtc(N);
  setRole(N, 'out');
  N.emit('replaced');
  refresh(N);
}

// the other player is gone: whoever stayed holds the room
function peerGone(N) {
  if (!N.linked) return;
  dropPeer(N);
  becomeHost(N);
  N.emit('status', 'peer-left');
}

// end the link with the other player (the game ends its round)
function dropPeer(N) {
  N.linked = false;
  N.weak = false; N.byeAt = 0;
  listenTo(N, null);
  closeRtc(N);
  dropQueue(N);
  N.emit('peer-gone');
  refresh(N);
}
