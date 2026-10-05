// Watchdog, several times a second: pulse and ping, broker upkeep, silence from the other player,
// rebuilding the direct link. Switching networks (Wi-Fi ↔ mobile) breaks both the direct link and the
// broker connections. So: a short silence pauses the game and waits; brokers reconnect on their own; the
// direct link is rebuilt. Only a really long silence ends the link.
import { tendBrokers, bestBrokers, kickBrokers } from './brokers.js';
import { dcLive, dcHear, dcFresh, closeRtc, startRtc, probeLink } from './rtc.js';
import { netRtt, pickRoute, refresh, sendDirect, sendRelay } from './link.js';

export function watch(N) {
  const now = performance.now(), slept = now - N.lastWatch > 1500;
  N.lastWatch = now;
  if (N.closed) return;
  // Our own tab was asleep (phone locked, timers throttled): the silence was ours, not theirs.
  // Give the connections a few seconds to come back before judging the other player.
  if (slept) { N.graceUntil = now + 5000; if (N.linked) N.lastSeen = now; kick(N); }
  tendBrokers(N, now);
  if (N.linked && dcLive(N) && now - N.statsAt > 2000) { N.statsAt = now; probeLink(N); }
  if (!N.linked) return;
  if (now - N.pingAt > 190) {
    N.pingAt = now; N.pN++;
    const p = pingMsg(N, now), dc = dcLive(N);
    if (dc) sendDirect(N, p);
    if (!dc || N.via !== 'p2p' || !dcFresh(N) || N.pN % 6 === 0) sendRelay(N, p);   // through the brokers when the game goes that way, and now and then to measure
  }
  N.emit('tick', now);
  if (now < N.graceUntil) return;
  const quiet = now - N.lastSeen;
  setWeak(N, !!N.byeAt || quiet > 2000);
  if (N.byeAt && now - N.byeAt > 20000) { N.peerGone(); return; }   // closed the tab and did not come back
  if (quiet > (N.patient() ? 90000 : N.lostAfter)) { N.peerGone(); return; }
  // a direct link that went quiet for long is closed; the guest then tries to build a new one
  if (dcLive(N) && now - (N.dcSeen || N.dcBorn) > 4000) closeRtc(N);
  if (N.role === 'guest' && !N.pc && !N.weak && now >= N.rtcNext) {
    N.rtcNext = now + [4000, 8000, 15000, 30000][Math.min(N.rtcTries, 3)];
    N.rtcTries++;
    startRtc(N);
  }
  if (pickRoute(N) !== N.via || now - N.viaAt > 1000) refresh(N);
}

// the link to the other player went quiet or came back
export function setWeak(N, v) {
  if (N.weak === v) return;
  N.weak = v;
  if (v) kick(N);                                      // silence: check our broker connections at once
  N.emit('weak', v);
  refresh(N);
}

// network changed, page came back, or silence: check the brokers now; the guest also retries the direct link soon
export function kick(N) {
  if (N.closed || !kickBrokers(N)) return;
  if (N.linked && N.role === 'guest') N.rtcNext = Math.min(N.rtcNext, performance.now() + 1500);
}

function pingMsg(N, now) {
  const m = { t: 'p', ts: Math.round(now * 10) / 10 };
  const rt = netRtt(N);
  if (rt != null) m.rt = Math.round(rt);               // our measured ping: the other player shows it too
  const extra = N.pulse && N.pulse(now);               // the game's own fields (see room.pulse)
  if (extra) m.g = extra;
  if (dcLive(N) && !dcHear(N)) m.r = 1;                // "I can't hear you directly": both sides then also use the brokers
  if (!dcFresh(N)) { const w = bestBrokers(N); if (w.length) m.w = w; }   // which brokers bring your data to me first
  return m;
}

// The direct link went quiet: speak up through the brokers right away instead of waiting for the next pulse.
export function keepDirectAlive(N, now) {
  if (N.linked && !N.closed && dcLive(N) && !dcFresh(N) && now - N.nudged > 400) {
    N.nudged = now; N.pingAt = now;
    const p = pingMsg(N, now); sendDirect(N, p); sendRelay(N, p);
  }
}
