// Where rooms meet and who we are: public MQTT brokers (signalling and fallback transport), STUN/TURN for
// direct links, player ids and room codes.

// Four brokers, so one outage does not matter: both players only need one broker in common.
// Two listen on port 443, which even strict networks (office Wi-Fi, some mobile carriers) leave open.
export const BROKERS = [
  { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { name: 'Eclipse', url: 'wss://mqtt.eclipseprojects.io/mqtt' },
  { name: 'Shiftr', url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' }
];

// The MQTT client runs on the library's origin, so it is pinned to one exact file: the browser refuses
// anything whose hash differs. To upgrade: npm pack mqtt@<version>, then
// echo sha384-$(openssl dgst -sha384 -binary package/dist/mqtt.min.js | base64)
export const MQTT_LIB = {
  urls: ['https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.min.js', 'https://unpkg.com/mqtt@5.16.0/dist/mqtt.min.js'],
  integrity: 'sha384-9WWboT9UtuPFRlOLq4FygQkcJxzYcpz8SXGkNyCEXM+44n14xzjNlrRKYZwuF/A6'
};

// Your own TURN relay (optional). When two players cannot connect directly, traffic goes through a relay;
// the closer it is, the lower the ping. A free metered.ca account gives one near you: paste its URLs and
// credentials ("TURN Credentials") here.
const MY_TURN = { urls: [], username: '', credential: '' };

export const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // public Open Relay TURN (the PeerJS server used earlier was shut down in 2023)
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
].concat(MY_TURN.username ? [MY_TURN] : []);

const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';      // no look-alikes (0/o, 1/l)
const code = n => Array.from({ length: n }, () => ABC[Math.floor(Math.random() * ABC.length)]).join('');

// Room codes: short enough to read out loud, long enough not to collide with strangers.
export const newRoomCode = () => code(6);
export const validRoomCode = r => typeof r === 'string' && /^[a-z0-9]{6,12}$/.test(r);

// A player id has two parts: a persistent one (this browser) and a per-tab one. The persistent part lets a
// room recognise the same person reopening the link in a new tab. window.__pid overrides it (tests).
function browserId() {
  try {
    let p = localStorage.getItem('ihroteka-pid');
    if (!p) { p = code(12); localStorage.setItem('ihroteka-pid', p); }
    return p;
  } catch (e) { return code(12); }
}
export const me = (window.__pid || browserId()) + '.' + code(6);
export const SENDER = /^[a-z0-9]{4,32}\.[a-z0-9]{4,12}$/;   // what a player id looks like
export const samePlayer = (a, b) => !!a && !!b && a.split('.')[0] === b.split('.')[0];

// The room's topic on the public brokers. Only a hash of game + code goes there, so someone listening to
// every topic learns no room codes and cannot join or disturb a room.
export async function roomTopic(game, room) {
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(game + ':' + room)));
    return 'ihroteka/' + Array.from(h.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return 'ihroteka/' + game + '/' + room; }   // no Web Crypto (page not served over https)
}
