// Who we are and where the room lives.

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
