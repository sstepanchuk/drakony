// Direct browser-to-browser link (WebRTC). Signalling goes through the brokers. Two data channels:
// 'fast' (unordered, no retransmits: state and aim) and 'ctl' (ordered, reliable: commands).
// A direct channel counts as alive only while something actually arrives through it.
//
// Every attempt has a number k carried by the offer, the answer and the candidates, so a late answer or
// candidate from an earlier attempt cannot spoil a newer one. Only the guest starts attempts (no glare).
import { ICE } from './config.js';
import { pubOn } from './brokers.js';
import { deliver, flushRelay } from './link.js';

const ICE_MAX = 50;                                    // candidates kept while waiting for an offer

export const dcLive = N => !!(N.dcF && N.dcC && N.dcF.readyState === 'open' && N.dcC.readyState === 'open');

// Do we hear the other player through the direct link? While they stream state every frame, a third of a
// second of silence already means it is broken; otherwise only the pulse goes through, so we wait longer.
export function dcHear(N) {
  if (!dcLive(N)) return false;
  const limit = N.via === 'p2p' && N.streaming() ? 350 : 1300;
  return performance.now() - N.dcSeen < limit;
}
// use the direct link only while we hear through it and the other player has not said they don't hear us
export const dcFresh = N => dcHear(N) && performance.now() - N.suspect > 1500;

const signal = (N, m) => { if (N.linked) pubOn(N, Object.assign(m, { t: 'rtc', to: N.other })); };

export function closeRtc(N) {
  clearTimeout(N.rtcTimer);
  const pc = N.pc, a = N.dcF, b = N.dcC;
  N.pc = null; N.dcF = null; N.dcC = null; N.iceQ = []; N.rtcK = null; N.via = 'relay'; N.turn = null; N.cand = ''; N.iceRtt = null; N.rD = null; N.sD = []; N.slowDirect = false;
  try { if (a) a.close(); } catch (e) {}
  try { if (b) b.close(); } catch (e) {}
  try { if (pc) pc.close(); } catch (e) {}
}

function newPc(N) {
  if (!window.RTCPeerConnection) return null;
  closeRtc(N);
  let pc;
  try { pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 1 }); } catch (e) { return null; }
  N.pc = pc;
  pc.onicecandidate = e => { if (e.candidate && !N.closed && N.pc === pc) signal(N, { k: N.rtcK, ice: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (N.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) { closeRtc(N); N.refresh(); }
  };
  // no direct link within 15 seconds: stay on the brokers, quietly
  N.rtcTimer = setTimeout(() => { if (N.pc === pc && !dcLive(N)) { closeRtc(N); N.refresh(); } }, 15000);
  return pc;
}

function wireDc(N, pc, dc) {
  const key = dc.label === 'fast' ? 'dcF' : 'dcC';
  dc.onopen = () => {
    if (N.closed || N.pc !== pc) return;
    N[key] = dc;
    if (!dcLive(N)) return;                            // wait until both channels are open
    flushRelay(N);
    N.dcBorn = performance.now();
    N.dcSeen = 0; N.rtcTries = 0;                      // it becomes "alive" when the first message arrives through it
    N.refresh();
  };
  dc.onclose = () => { if (N.pc === pc) { closeRtc(N); N.refresh(); } };
  dc.onmessage = e => {
    if (N.closed || N.pc !== pc) return;
    N.dcSeen = performance.now();
    let x; try { x = JSON.parse(e.data); } catch (err) { return; }
    try { deliver(N, x, false); } catch (err) { console.error(err); }   // one bad message must not break the channel
  };
}

export function startRtc(N) {
  const pc = newPc(N);
  if (!pc) return;
  N.rtcK = Date.now() % 1e9;
  // fast channel: no ordering, no retransmits — a lost packet does not hold up the next ones
  wireDc(N, pc, pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
  wireDc(N, pc, pc.createDataChannel('ctl', { ordered: true }));
  pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
    if (N.pc === pc) signal(N, { k: N.rtcK, sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
  }).catch(() => {});
}

function drainIce(N, pc) {
  const list = N.iceQ; N.iceQ = [];
  for (const q of list) if (q.k === N.rtcK) pc.addIceCandidate(q.c).catch(() => {});
}

export function onRtc(N, m) {
  if (m.sdp && m.sdp.type === 'offer' && typeof m.sdp.sdp === 'string') {
    const early = N.iceQ.filter(q => q.k === m.k);     // candidates of this attempt that overtook the offer
    const pc = newPc(N);
    if (!pc) return;
    N.rtcK = m.k; N.iceQ = early;
    pc.ondatachannel = e => wireDc(N, pc, e.channel);
    pc.setRemoteDescription(m.sdp).then(() => { drainIce(N, pc); return pc.createAnswer(); })
      .then(a => pc.setLocalDescription(a))
      .then(() => { if (N.pc === pc) signal(N, { k: m.k, sdp: { type: 'answer', sdp: pc.localDescription.sdp } }); })
      .catch(() => {});
  } else if (m.sdp && m.sdp.type === 'answer' && typeof m.sdp.sdp === 'string') {
    const pc = N.pc;
    if (pc && m.k === N.rtcK && pc.signalingState === 'have-local-offer') pc.setRemoteDescription(m.sdp).then(() => drainIce(N, pc)).catch(() => {});
  } else if (m.ice && typeof m.ice === 'object') {
    const pc = N.pc;
    if (pc && m.k === N.rtcK && pc.remoteDescription) pc.addIceCandidate(m.ice).catch(() => {});
    else if (N.iceQ.length < ICE_MAX) N.iceQ.push({ k: m.k, c: m.ice });
  }
}

// Ask the browser about the direct link: is it really direct or through a relay (both players behind strict
// routers), and what is its network round trip.
export function probeLink(N) {
  const pc = N.pc;
  if (!pc || !pc.getStats) return;
  pc.getStats().then(st => {
    if (N.pc !== pc) return;
    let pair = null;
    st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId) || pair; });
    if (!pair) st.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return;
    const a = st.get(pair.localCandidateId), b = st.get(pair.remoteCandidateId);
    N.turn = !!((a && a.candidateType === 'relay') || (b && b.candidateType === 'relay'));
    N.cand = (a ? a.candidateType + '/' + (a.relayProtocol || a.protocol || '?') : '?') + ' - ' + (b ? b.candidateType : '?');
    if (typeof pair.currentRoundTripTime === 'number') N.iceRtt = pair.currentRoundTripTime * 1000;
  }).catch(() => {});
}
