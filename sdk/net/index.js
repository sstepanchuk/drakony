// @ihroteka/net — two-player rooms for library games. Public MQTT brokers find the other player and carry
// the game when nothing better works; a direct WebRTC link takes over when it can. No server of our own.
//
//   import { joinRoom, newRoomCode, validRoomCode, preload } from '@ihroteka/net';
//   const room = joinRoom({ game: 'my-game', code });
//   room.on('linked', () => room.send({ t: 'hello' }));
//   room.on('message', m => …);
//
// See README.md ("Multiplayer") for the events and the room's methods.
import { loadTransport } from './brokers.js';

export { joinRoom } from './room.js';
export { newRoomCode, validRoomCode } from './identity.js';
export { loadTransport };
// start loading the transport early (e.g. while the player is still in the menu); never throws
export const preload = () => { loadTransport().catch(() => {}); };
