/* =====================================================================
   ШИФРУВАННЯ БІБЛІОТЕКИ
   Один і той самий код працює в браузері й у Node (обидва мають Web Crypto).

   Як це влаштовано:
   - Усе вміст бібліотеки (ігри, їхній код, список ігор) зашифровано одним ключем бібліотеки (AES-GCM).
   - У кожної людини своя пара ключів (ECDH P-256). Ключ бібліотеки лежить у keyring.json
     окремою «скринькою» для кожної людини: відкрити її може лише її приватний ключ.
   - Приватний ключ зашифровано паролем цієї людини (PBKDF2, 600 000 кроків).
   Тож пароль відмикає лише твій приватний ключ, а вже ним — ключ бібліотеки. Додати чи
   прибрати людину можна, не знаючи паролів інших: потрібні лише їхні публічні ключі.
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

// «Мітка» шифротексту: те саме, що й назва файлу. Файл, підкладений під іншою назвою, не розшифрується.
export const label = {
  library: () => 'drakony:library',
  game: id => 'drakony:game:' + id,
  source: id => 'drakony:source:' + id,
  name: id => 'drakony:name:' + id,
  priv: id => 'drakony:priv:' + id,
  box: id => 'drakony:box:' + id
};

/* ---------- симетричне шифрування: [12 байтів iv][шифротекст] ---------- */
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

/* ---------- ключ бібліотеки ---------- */
export const newLibraryKey = () => random(32);
export const importLibraryKey = (raw, extractable = false) => subtle.importKey('raw', raw, AES, extractable, ['encrypt', 'decrypt']);

/* ---------- пароль ---------- */
export async function passwordKey(password, salt, iterations = ITERATIONS) {
  const base = await subtle.importKey('raw', utf8.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, AES, false, ['encrypt', 'decrypt']);
}

/* ---------- скринька з ключем бібліотеки для однієї людини ---------- */
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

/* ---------- людина: пара ключів, приватний зашифровано паролем ---------- */
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

/* Вхід паролем: шукаємо людину, чий приватний ключ він відмикає.
   Повертає { person, priv }, де priv — приватний ключ, який не можна витягти зі сховища браузера.
   extractable потрібен лише інструментам у Node. */
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

// ключ бібліотеки з приватного ключа людини
export async function libraryKey(keyring, id, priv, extractable = false) {
  const person = keyring.people.find(p => p.id === id);
  if (!person) return null;
  const raw = await openBox(person, priv);
  return { key: await importLibraryKey(raw, extractable), raw: extractable ? raw : null };
}

export const newKeyring = () => ({ v: 1, kdf: { salt: toB64(random(16)), iterations: ITERATIONS }, people: [] });
