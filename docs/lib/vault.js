/* =====================================================================
   LIBRARY ENCRYPTION — runs unchanged in the browser and in Node (Web Crypto).

   - All content (games, their sources, the game list) is sealed with one library key (AES-256-GCM).
   - Each person has an ECDH P-256 key pair. keyring.json holds, per person, a "box" with the library
     key that only their private key opens, and their private key sealed with their password
     (PBKDF2-SHA-256). People can be added or removed without knowing anyone else's password.
   ===================================================================== */
const { subtle } = globalThis.crypto;
const AES = { name: 'AES-GCM', length: 256 };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const enc = new TextEncoder(), dec = new TextDecoder();

export const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const b64 = u8 => btoa(Array.from(new Uint8Array(u8), b => String.fromCharCode(b)).join(''));
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const text = u8 => dec.decode(u8);

// Associated data for every ciphertext: a file swapped in under another name will not decrypt.
export const label = {
  library: () => 'drakony:library',
  game: id => 'drakony:game:' + id,
  source: id => 'drakony:source:' + id,
  name: id => 'drakony:name:' + id,
  priv: id => 'drakony:priv:' + id,
  box: id => 'drakony:box:' + id
};

/* ---------- AES-GCM: [12-byte iv][ciphertext + tag] ---------- */
export async function seal(key, data, aad) {
  const iv = random(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, typeof data === 'string' ? enc.encode(data) : data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return out;
}
export async function unseal(key, blob, aad) {
  const u = new Uint8Array(blob);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: enc.encode(aad) }, key, u.subarray(12)));
}
// the key can be used but never read back
export const importKey = raw => subtle.importKey('raw', raw, AES, false, ['encrypt', 'decrypt']);
export const newLibraryKey = () => random(32);

/* ---------- keys derived from a password and from a key exchange ---------- */
async function passwordKey(keyring, password) {
  const base = await subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(keyring.kdf.salt), iterations: keyring.kdf.iterations }, base, AES, false, ['encrypt', 'decrypt']);
}
// ECDH + HKDF; both sides salt with the box's ephemeral public key (epk)
async function boxKey(priv, pubRaw, epk, id) {
  const pub = await subtle.importKey('raw', pubRaw, ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(label.box(id)) }, hkdf, AES, false, ['encrypt', 'decrypt']);
}

/* ---------- keyring ---------- */
export const newKeyring = () => ({ v: 1, kdf: { salt: b64(random(16)), iterations: 600000 }, people: [] });

// a new person: fresh key pair, private key sealed with their password (box and name are added by the caller)
export async function newPerson(keyring, id, password) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  return {
    id,
    pub: b64(await subtle.exportKey('raw', pair.publicKey)),
    priv: b64(await seal(await passwordKey(keyring, password), pkcs8, label.priv(id)))
  };
}

// the library key in a box only this person can open (ephemeral-static ECDH)
export async function boxFor(person, libraryRaw) {
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await boxKey(eph.privateKey, unb64(person.pub), epk, person.id);
  return { epk: b64(epk), ct: b64(await seal(key, libraryRaw, label.box(person.id))) };
}

// Sign in: find the person whose private key this password opens. → { person, priv } or null
export async function signIn(keyring, password) {
  const key = await passwordKey(keyring, password);   // one slow derivation, then a cheap check per person
  for (const person of keyring.people) {
    const pkcs8 = await unseal(key, unb64(person.priv), label.priv(person.id)).catch(() => null);
    if (pkcs8) return { person, priv: await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']) };
  }
  return null;
}

// the raw library key from a person's box → Uint8Array, or null if they are no longer in the keyring
export async function libraryKey(keyring, id, priv) {
  const person = keyring.people.find(p => p.id === id);
  if (!person) return null;
  const epk = unb64(person.box.epk);
  return unseal(await boxKey(priv, epk, epk, id), unb64(person.box.ct), label.box(id));
}

export async function changePassword(keyring, person, oldPassword, newPassword) {
  const pkcs8 = await unseal(await passwordKey(keyring, oldPassword), unb64(person.priv), label.priv(person.id));
  person.priv = b64(await seal(await passwordKey(keyring, newPassword), pkcs8, label.priv(person.id)));
}
