// Where rooms meet: public MQTT brokers (signalling and fallback transport) and STUN/TURN for direct links.

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
