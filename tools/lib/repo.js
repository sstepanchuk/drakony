// Repository model: where things live, the keyring, sealed files and game source archives.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as vault from '../../docs/lib/vault.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const P = {
  games: path.join(ROOT, 'games'),       // plaintext sources (local only)
  site: path.join(ROOT, 'docs'),         // published site
  vault: path.join(ROOT, 'vault'),       // encrypted sources
  keyring: path.join(ROOT, 'docs', 'keyring.json'),
  template: path.join(ROOT, 'tools', 'templates', 'game.html'),
  api: path.join(ROOT, 'tools', 'runtime', 'library-api.js')
};
export const rel = p => path.relative(ROOT, p);
export const exists = fs.existsSync;
export const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
export const fail = msg => { console.error('✗ ' + msg); process.exit(1); };
export const homepage = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).homepage || '';

export const gameIds = () => exists(P.games) ? fs.readdirSync(P.games).filter(id => exists(path.join(P.games, id, 'game.json'))).sort() : [];
export const sourceIds = () => exists(P.vault) ? fs.readdirSync(P.vault).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)).sort() : [];
export const sitePath = (...p) => path.join(P.site, ...p);
export const sourcePath = id => path.join(P.vault, id + '.bin');

/* ---------- keyring & people ---------- */
export const readKeyring = () => exists(P.keyring) ? JSON.parse(fs.readFileSync(P.keyring, 'utf8')) : fail('No ' + rel(P.keyring) + '. Start with `node tools/cli.js init <name> …`.');
export const writeKeyring = kr => fs.writeFileSync(P.keyring, JSON.stringify(kr, null, 2) + '\n');

// → { kr, me, raw, key }: the keyring, who signed in, and the library key
export async function open(password) {
  const kr = readKeyring();
  const who = await vault.signIn(kr, password);
  if (!who) fail('Wrong password.');
  const raw = await vault.libraryKey(kr, who.person.id, who.priv);
  return { kr, me: who.person, raw, key: await vault.importKey(raw) };
}
export const nameOf = (key, p) => vault.unseal(key, vault.unb64(p.name), vault.label.name(p.id)).then(vault.text, () => '?');

export async function addPerson(kr, raw, key, name, password) {
  const id = Buffer.from(vault.random(6)).toString('hex');
  const person = await vault.newPerson(kr, id, password);
  person.name = vault.b64(await vault.seal(key, name, vault.label.name(id)));
  person.box = await vault.boxFor(person, raw);
  kr.people.push(person);
}

// 12 characters without look-alikes (0/o, 1/l): ~60 bits of entropy
export function makePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < 12) { const b = vault.random(1)[0]; if (b < abc.length * 8) s += abc[b % abc.length]; }
  return s.match(/.{4}/g).join('-');
}

/* ---------- sealed files ---------- */
// writes only when the plaintext changed, so unchanged builds leave git clean → true if written
export async function writeSealed(file, data, aad, key) {
  const plain = typeof data === 'string' ? Buffer.from(data) : data;
  if (exists(file) && await vault.unseal(key, fs.readFileSync(file), aad).then(old => same(old, plain), () => false)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await vault.seal(key, plain, aad));
  return true;
}
export const readSealed = (file, aad, key) => vault.unseal(key, fs.readFileSync(file), aad);

// every sealed file with its label
export function sealedFiles() {
  const out = [];
  if (exists(sitePath('library.bin'))) out.push([sitePath('library.bin'), vault.label.library()]);
  for (const id of fs.readdirSync(P.site)) if (exists(sitePath(id, 'game.bin'))) out.push([sitePath(id, 'game.bin'), vault.label.game(id)]);
  for (const id of sourceIds()) out.push([sourcePath(id), vault.label.source(id)]);
  return out;
}

// new library key for everyone in kr.people; every sealed file and name is re-encrypted
export async function rotate(kr, key) {
  const raw2 = vault.newLibraryKey(), key2 = await vault.importKey(raw2);
  for (const [file, aad] of sealedFiles()) fs.writeFileSync(file, await vault.seal(key2, await readSealed(file, aad, key), aad));
  for (const p of kr.people) {
    const aad = vault.label.name(p.id);
    p.name = vault.b64(await vault.seal(key2, await vault.unseal(key, vault.unb64(p.name), aad), aad));
    p.box = await vault.boxFor(p, raw2);
  }
}

/* ---------- game sources: folder ⇄ one gzipped JSON archive ---------- */
export function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])
    .sort();
}
export function packSource(dir) {
  const files = Object.fromEntries(walk(dir).map(f => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]));
  return zlib.gzipSync(JSON.stringify({ v: 1, files }), { level: 9 });
}
export const unpackSource = buf => Object.entries(JSON.parse(zlib.gunzipSync(buf)).files).map(([f, b64]) => [f, Buffer.from(b64, 'base64')]);
