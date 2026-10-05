/* =====================================================================
   LIBRARY ENCRYPTION
   The same code runs in the browser and in Node (both have Web Crypto).

   How it works:
   - All library content (games, their sources, the game list) is encrypted with one library key (AES-GCM).
   - Each person has an ECDH P-256 key pair. keyring.json holds a separate "box" with the library key
     for every person; only that person's private key can open it.
   - The private key is encrypted with that person's password (PBKDF2, 600,000 iterations).
   So a password unlocks only your private key, which then unlocks the library key. People can be
   added or removed without knowing anyone else's password: only their public keys are needed.
   ===================================================================== */
const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder(), text = new TextDecoder();
const AES = { name: 'AES-GCM', length: 256 };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export const ITERATIONS = 600000;

export const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const toB64 = u8 => { let s = ''; for (const b of new Uint8Array(u8)) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const toText = u8 => text.decode(u8);
const bytes = v => typeof v === 'string' ? utf8.encode(v) : new Uint8Array(v);

// Ciphertext label (AES-GCM associated data): a file swapped in under another name will not decrypt.
export const label = {
  library: () => 'drakony:library',
  game: id => 'drakony:game:' + id,
  source: id => 'drakony:source:' + id,
  name: id => 'drakony:name:' + id,
  priv: id => 'drakony:priv:' + id,
  box: id => 'drakony:box:' + id
};

/* ---------- symmetric encryption: [12-byte iv][ciphertext] ---------- */
export async function seal(key, data, aad) {
  const iv = random(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, bytes(data)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function unseal(key, blob, aad) {
  const u = new Uint8Array(blob);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: utf8.encode(aad) }, key, u.subarray(12)));
}

/* ---------- library key ---------- */
export const newLibraryKey = () => random(32);
export const importLibraryKey = (raw, extractable = false) => subtle.importKey('raw', raw, AES, extractable, ['encrypt', 'decrypt']);

/* ---------- password ---------- */
export async function passwordKey(password, salt, iterations = ITERATIONS) {
  const base = await subtle.importKey('raw', utf8.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, AES, false, ['encrypt', 'decrypt']);
}

/* ---------- a box holding the library key for one person ---------- */
async function boxKey(myPriv, theirPub, salt, id) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(label.box(id)) }, hk, AES, false, ['encrypt', 'decrypt']);
}
export async function boxFor(person, libRaw) {
  const pub = await subtle.importKey('raw', fromB64(person.pub), ECDH, true, []);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const k = await boxKey(eph.privateKey, pub, epk, person.id);
  return { epk: toB64(epk), ct: toB64(await seal(k, libRaw, label.box(person.id))) };
}
export async function openBox(person, priv) {
  const epk = fromB64(person.box.epk);
  const pub = await subtle.importKey('raw', epk, ECDH, true, []);
  const k = await boxKey(priv, pub, epk, person.id);
  return unseal(k, fromB64(person.box.ct), label.box(person.id));
}

/* ---------- a person: key pair, private key encrypted with their password ---------- */
export async function newPerson(id, password, keyring) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = toB64(await subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const pk = await passwordKey(password, fromB64(keyring.kdf.salt), keyring.kdf.iterations);
  return { id, pub, priv: toB64(await seal(pk, pkcs8, label.priv(id))) };
}
export async function repassword(person, oldPassword, newPassword, keyring) {
  const salt = fromB64(keyring.kdf.salt);
  const pkcs8 = await unseal(await passwordKey(oldPassword, salt, keyring.kdf.iterations), fromB64(person.priv), label.priv(person.id));
  person.priv = toB64(await seal(await passwordKey(newPassword, salt, keyring.kdf.iterations), pkcs8, label.priv(person.id)));
}

/* Sign in with a password: find the person whose private key it unlocks.
   Returns { person, priv }, where priv is a private key that cannot be exported from browser storage.
   extractable is only needed by the Node tooling. */
export async function signIn(keyring, password, extractable = false) {
  const pk = await passwordKey(password, fromB64(keyring.kdf.salt), keyring.kdf.iterations);
  for (const person of keyring.people) {
    let pkcs8;
    try { pkcs8 = await unseal(pk, fromB64(person.priv), label.priv(person.id)); } catch (e) { continue; }
    const priv = await subtle.importKey('pkcs8', pkcs8, ECDH, extractable, ['deriveBits']);
    return { person, priv };
  }
  return null;
}

// the library key, opened with a person's private key
export async function libraryKey(keyring, id, priv, extractable = false) {
  const person = keyring.people.find(p => p.id === id);
  if (!person) return null;
  const raw = await openBox(person, priv);
  return { key: await importLibraryKey(raw, extractable), raw: extractable ? raw : null };
}

export const newKeyring = () => ({ v: 1, kdf: { salt: toB64(random(16)), iterations: ITERATIONS }, people: [] });
