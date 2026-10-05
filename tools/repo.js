// Repository model: where things live, the keyring, sealed files and game source archives.
// Library code throws Problem for anything the user can fix; only cli.js prints and exits.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as vault from '../sdk/vault/index.js';

export class Problem extends Error {}
export const problem = msg => { throw new Problem(msg); };

// IHROTEKA_ROOT lets tests run the tools against a scratch copy of the repository
export const ROOT = path.resolve(process.env.IHROTEKA_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const TOOLS = path.dirname(fileURLToPath(import.meta.url));
export const P = {
  games: path.join(ROOT, 'games'),       // plaintext sources (local only)
  site: path.join(ROOT, 'docs'),         // published site
  vault: path.join(ROOT, 'vault'),       // encrypted sources
  keyring: path.join(ROOT, 'docs', 'keyring.json'),
  sdk: path.join(TOOLS, '..', 'sdk')     // @ihroteka/<name> modules: vault, shelf, api, net
};
export const rel = p => path.relative(ROOT, p) || '.';
export const exists = fs.existsSync;
export const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
// content types of everything a game or the site may contain
export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const homepage = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).homepage || '';

export const gameIds = () => exists(P.games) ? fs.readdirSync(P.games).filter(id => exists(path.join(P.games, id, 'game.json'))).sort() : [];
export const sourceIds = () => exists(P.vault) ? fs.readdirSync(P.vault).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)).sort() : [];
export const siteGames = () => exists(P.site) ? fs.readdirSync(P.site).filter(d => exists(path.join(P.site, d, 'game.bin'))).sort() : [];
export const sitePath = (...p) => path.join(P.site, ...p);
export const sourcePath = id => path.join(P.vault, id + '.bin');

// write next to the target, then rename: a crash never leaves a half-written file
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
}

// refuse to touch encrypted files with uncommitted changes (the only backup is git)
export function requireClean(...dirs) {
  let out;
  try { out = execFileSync('git', ['status', '--porcelain', '--', ...dirs.map(rel)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return; }                                  // not a git checkout: nothing to compare with
  if (out.trim()) problem('Uncommitted changes in ' + dirs.map(rel).join(', ') + '. Commit or discard them first (git is the only backup of encrypted files).');
}

/* ---------- keyring & people ---------- */
export function readKeyring() {
  if (!exists(P.keyring)) problem('No ' + rel(P.keyring) + '. Start with `node tools/cli.js init <name> …`.');
  const kr = JSON.parse(fs.readFileSync(P.keyring, 'utf8'));
  if (kr.v !== vault.KEYRING_V) problem(rel(P.keyring) + ' is format v' + kr.v + ', these tools read v' + vault.KEYRING_V + '.');
  return kr;
}
export const writeKeyring = kr => writeAtomic(P.keyring, JSON.stringify(kr, null, 2) + '\n');

// → { kr, me, raw, key, kid }: the keyring, who signed in, and the library key
export async function open(password) {
  const kr = readKeyring();
  const who = await vault.signIn(kr, password);
  if (!who) problem('Wrong password.');
  const raw = await vault.libraryKey(kr, who.person.id, who.priv);
  const kid = await vault.keyId(raw);
  if (kr.kid !== kid) problem('keyring.json is inconsistent: its key id does not match the library key.');
  return { kr, me: who.person, raw, key: await vault.importKey(raw), kid };
}
// names are sealed with the library key: only people with access see who else has it
const sealName = async (key, id, name) => vault.b64(await vault.seal(key, name, vault.label.name(id)));
const openName = (key, p) => vault.unseal(key, vault.unb64(p.name), vault.label.name(p.id)).then(vault.text);
export const nameOf = (key, p) => openName(key, p).catch(() => '?');

export async function addPerson(kr, raw, key, name, password) {
  const id = Buffer.from(vault.random(6)).toString('hex');
  const person = await vault.newPerson(kr, id, password);
  person.name = await sealName(key, id, name);
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
export function checkNewPassword(pw) {
  if (pw !== pw.trim()) problem('A password must not start or end with a space.');
  if (pw.length < 12) problem('Too short: at least 12 characters. The keyring is public, so short passwords can be brute-forced.');
}

/* ---------- sealed files ---------- */
// every sealed file with its label
export function sealedFiles() {
  const out = [];
  if (exists(sitePath('library.bin'))) out.push([sitePath('library.bin'), vault.label.library()]);
  for (const id of siteGames()) out.push([sitePath(id, 'game.bin'), vault.label.game(id)]);
  for (const id of sourceIds()) out.push([sourcePath(id), vault.label.source(id)]);
  return out;
}
export function readSealed(file, aad, { key, kid }) {
  const blob = fs.readFileSync(file);
  if (vault.fileKid(blob) !== kid) problem(rel(file) + ' is sealed with another library key (stale checkout? run git pull).');
  return vault.openFile(key, blob, aad);
}
// writes only when the content changed (equal(old, new) decides), so unchanged builds leave git clean → true if written
export async function writeSealed(file, plain, aad, lib, equal = same) {
  if (exists(file)) {
    const blob = fs.readFileSync(file);
    if (vault.fileKid(blob) === lib.kid) {
      const old = await vault.openFile(lib.key, blob, aad).catch(() => null);
      if (old && equal(old, plain)) return false;
    }
  }
  writeAtomic(file, await vault.sealFile(lib.key, lib.kid, plain, aad));
  return true;
}

// New library key for everyone left in kr.people. Everything is decrypted first, so any failure happens
// before a single write; then new files go to *.tmp and are renamed into place, the keyring last.
export async function rotate(kr, lib) {
  const files = [];
  for (const [file, aad] of sealedFiles()) files.push([file, aad, await readSealed(file, aad, lib)]);
  const names = [];
  for (const p of kr.people) names.push(await openName(lib.key, p));
  const raw = vault.newLibraryKey(), next = { raw, key: await vault.importKey(raw), kid: await vault.keyId(raw) };
  for (const [file, aad, plain] of files) fs.writeFileSync(file + '.tmp', await vault.sealFile(next.key, next.kid, plain, aad));
  for (const [i, p] of kr.people.entries()) {
    p.name = await sealName(next.key, p.id, names[i]);
    p.box = await vault.boxFor(p, raw);
  }
  kr.kid = next.kid;
  for (const [file] of files) fs.renameSync(file + '.tmp', file);
  writeKeyring(kr);
  return next;
}

/* ---------- game sources: folder ⇄ one gzipped JSON archive (dotfiles are not included) ---------- */
export function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])
    .sort();
}
const readFolder = dir => Object.fromEntries(walk(dir).map(f => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]));
export const packSource = dir => zlib.gzipSync(JSON.stringify({ v: 1, files: readFolder(dir) }), { level: 9 });
export const unpackSource = buf => JSON.parse(zlib.gunzipSync(buf)).files;
// archives are compared by their files, not by gzip bytes (those differ between zlib versions)
const sameFiles = (a, b) => { const x = unpackSource(a), y = unpackSource(b); return JSON.stringify(x) === JSON.stringify(y); };
export const writeSource = (id, lib) => writeSealed(sourcePath(id), packSource(path.join(P.games, id)), vault.label.source(id), lib, sameFiles);
