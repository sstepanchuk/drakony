#!/usr/bin/env node
/* Library tooling. Run via npm scripts (see README or `node tools/cli.js help`).
   The password is read from VAULT_PASSWORD, or prompted for. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as V from '../docs/lib/vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  games: path.join(ROOT, 'games'),
  site: path.join(ROOT, 'docs'),
  vault: path.join(ROOT, 'vault'),
  keyring: path.join(ROOT, 'docs', 'keyring.json'),
  template: path.join(ROOT, 'tools', 'templates', 'game.html')
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rel = p => path.relative(ROOT, p);
const fail = msg => { console.error('✗ ' + msg); process.exit(1); };
const exists = p => fs.existsSync(p);
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/* ---------- input ---------- */
function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) rl._writeToOutput = s => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, answer => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}
const askPassword = (q = 'Password: ') => process.env.VAULT_PASSWORD || ask(q, true);

// 12 characters without look-alikes (0/o, 1/l): ~60 bits of entropy
function makePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < 12) { const b = V.random(1)[0]; if (b < abc.length * 8) s += abc[b % abc.length]; }
  return s.match(/.{4}/g).join('-');
}

/* ---------- keys ---------- */
const readKeyring = () => exists(P.keyring) ? JSON.parse(fs.readFileSync(P.keyring, 'utf8')) : fail('No ' + rel(P.keyring) + '. Start with `node tools/cli.js init <name> …`.');
const writeKeyring = kr => fs.writeFileSync(P.keyring, JSON.stringify(kr, null, 2) + '\n');

// sign in with a password: who you are and the library key
async function signIn() {
  const kr = readKeyring();
  const who = await V.signIn(kr, await askPassword(), true);
  if (!who) fail('Wrong password.');
  const { key, raw } = await V.libraryKey(kr, who.person.id, who.priv, true);
  return { kr, me: who.person, key, raw };
}
const nameOf = async (key, p) => { try { return V.toText(await V.unseal(key, V.fromB64(p.name), V.label.name(p.id))); } catch (e) { return '?'; } };

async function addPerson(kr, key, raw, name, password) {
  const id = Buffer.from(V.random(6)).toString('hex');
  const person = await V.newPerson(id, password, kr);
  person.name = V.toB64(await V.seal(key, name, V.label.name(id)));
  person.box = await V.boxFor(person, raw);
  kr.people.push(person);
  return person;
}

/* ---------- encrypted files ---------- */
// write only when the plaintext actually changed, otherwise every build would touch every file
async function writeSealed(file, data, aad, key) {
  const plain = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (exists(file)) {
    try { if (eq(await V.unseal(key, fs.readFileSync(file), aad), plain)) return false; } catch (e) {}
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await V.seal(key, plain, aad));
  return true;
}
// every encrypted file with its label (for key rotation)
function sealedFiles() {
  const out = [];
  if (exists(path.join(P.site, 'library.bin'))) out.push([path.join(P.site, 'library.bin'), V.label.library()]);
  for (const id of fs.readdirSync(P.site)) {
    const f = path.join(P.site, id, 'game.bin');
    if (exists(f)) out.push([f, V.label.game(id)]);
  }
  if (exists(P.vault)) for (const f of fs.readdirSync(P.vault)) if (f.endsWith('.bin')) out.push([path.join(P.vault, f), V.label.source(f.slice(0, -4))]);
  return out;
}

/* ---------- game sources: folder → single archive ---------- */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
function packSource(dir) {
  const files = {};
  for (const f of walk(dir)) files[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
  return zlib.gzipSync(JSON.stringify({ v: 1, files }), { level: 9 });
}
const unpackSource = buf => JSON.parse(zlib.gunzipSync(buf).toString('utf8')).files;

/* ---------- bundling a game into one page ---------- */
async function bundleGame(dir) {
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  // stylesheets
  for (const m of [...html.matchAll(/<link rel="stylesheet" href="([^":]+)">/g)]) {
    const css = (await esbuild.transform(fs.readFileSync(path.join(dir, m[1]), 'utf8'), { loader: 'css', minify: true, charset: 'utf8' })).code;
    html = html.replace(m[0], () => '<style>' + css.trim() + '</style>');
  }
  // module scripts: bundle into one classic script
  for (const m of [...html.matchAll(/<script type="module" src="([^":]+)"><\/script>/g)]) {
    const r = await esbuild.build({ entryPoints: [path.join(dir, m[1])], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', charset: 'utf8', legalComments: 'none', logLevel: 'silent' });
    const js = r.outputFiles[0].text.trim();
    if (/<\/script/i.test(js)) fail('The bundle contains "</script", it cannot be inlined.');
    html = html.replace(m[0], () => '<script>' + js + '</script>');
  }
  return html;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function gamePage(id, g) {
  const base = (pkg.homepage || '').replace(/\/?$/, '/');
  const vals = {
    title: g.title, description: g.description, shareTitle: g.shareTitle || g.title, shareDescription: g.shareDescription || g.description,
    image: g.image, imageAlt: g.imageAlt || g.title, imageUrl: base + id + '/' + g.image, emoji: g.emoji || '🎮', theme: g.theme || '#e4e2f0'
  };
  return fs.readFileSync(P.template, 'utf8')
    .replace('{{idJson}}', JSON.stringify(id))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => k in vals ? esc(vals[k]) : fail('Template: unknown field ' + k));
}

const gameIds = () => exists(P.games) ? fs.readdirSync(P.games).filter(id => exists(path.join(P.games, id, 'game.json'))).sort() : [];
const sourceIds = () => exists(P.vault) ? fs.readdirSync(P.vault).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)).sort() : [];

/* =====================================================================
   COMMANDS
   ===================================================================== */
const commands = {
  async help() {
    console.log(`Library commands

  npm run unlock                 decrypt game sources into games/ (for editing)
  npm run dev [-- docs]          local server for games/ (or the built site in docs/)
  npm run build                  bundle, encrypt and update docs/ and vault/
  npm run check                  validate docs/ before publishing (no password needed)

  npm run user -- list           who has access
  npm run user -- add <name>     add a person (a password is generated and shown once)
  npm run user -- remove <name>  remove a person (rotates the library key, re-encrypts everything)
  npm run user -- passwd         change your password

  node tools/cli.js init <name> …  create a new library (once)

Set VAULT_PASSWORD to skip the password prompt.`);
  },

  async init(...names) {
    if (exists(P.keyring)) fail('A library already exists: ' + rel(P.keyring));
    if (!names.length) fail('Give at least one name: node tools/cli.js init <name> …');
    const kr = V.newKeyring(), raw = V.newLibraryKey(), key = await V.importLibraryKey(raw);
    console.log('New library. Passwords are shown only once, save them:\n');
    for (const name of names) {
      const pw = makePassword();
      await addPerson(kr, key, raw, name, pw);
      console.log('  ' + name.padEnd(12) + pw);
    }
    writeKeyring(kr);
    console.log('\nNext: npm run build');
  },

  async unlock(...flags) {
    const force = flags.includes('--force');
    const { key } = await signIn();
    for (const id of sourceIds()) {
      const files = unpackSource(await V.unseal(key, fs.readFileSync(path.join(P.vault, id + '.bin')), V.label.source(id)));
      const dir = path.join(P.games, id);
      const changed = Object.entries(files).filter(([f, b64]) => { const p = path.join(dir, f); return exists(p) && !eq(fs.readFileSync(p), Buffer.from(b64, 'base64')); });
      if (changed.length && !force) { console.log('! ' + id + ': local files differ (' + changed.map(c => c[0]).join(', ') + '), skipped. Overwrite: npm run unlock -- --force'); continue; }
      for (const [f, b64] of Object.entries(files)) {
        const p = path.join(dir, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      }
      console.log('✓ ' + rel(dir));
    }
  },

  async build() {
    const ids = gameIds();
    const missing = sourceIds().filter(id => !ids.includes(id));
    if (missing.length) fail('Decrypt the sources first (npm run unlock): missing games/' + missing.join(', games/'));
    if (!ids.length) fail('No games in games/.');
    const { key } = await signIn();
    const library = [];
    for (const id of ids) {
      const dir = path.join(P.games, id), g = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
      const out = path.join(P.site, id);
      fs.mkdirSync(out, { recursive: true });
      const html = await bundleGame(dir);
      const wrote = [
        await writeSealed(path.join(out, 'game.bin'), html, V.label.game(id), key),
        await writeSealed(path.join(P.vault, id + '.bin'), packSource(dir), V.label.source(id), key)
      ];
      fs.copyFileSync(path.join(dir, g.image), path.join(out, g.image));
      fs.writeFileSync(path.join(out, 'index.html'), gamePage(id, g));
      library.push({ id, title: g.title, tagline: g.tagline, image: g.image, emoji: g.emoji });
      console.log('✓ ' + id + ': ' + (html.length / 1024).toFixed(0) + ' KB' + (wrote.some(Boolean) ? '' : ' (unchanged)'));
    }
    await writeSealed(path.join(P.site, 'library.bin'), JSON.stringify(library), V.label.library(), key);
  },

  async user(sub, ...args) {
    if (sub === 'list') {
      const { kr, me, key } = await signIn();
      for (const p of kr.people) console.log((p.id === me.id ? '* ' : '  ') + await nameOf(key, p));
      return;
    }
    if (sub === 'add') {
      const name = args.join(' ');
      if (!name) fail('npm run user -- add <name>');
      const { kr, key, raw } = await signIn();
      for (const p of kr.people) if (await nameOf(key, p) === name) fail('That name is already taken.');
      const pw = makePassword();
      await addPerson(kr, key, raw, name, pw);
      writeKeyring(kr);
      console.log('✓ ' + name + ' has access. Password (shown once): ' + pw);
      return;
    }
    if (sub === 'remove') {
      const name = args.join(' ');
      const { kr, me, key } = await signIn();
      const keep = [], gone = [];
      for (const p of kr.people) (await nameOf(key, p) === name ? gone : keep).push(p);
      if (!gone.length) fail('No such name. See: npm run user -- list');
      if (gone.some(p => p.id === me.id)) fail('You cannot remove yourself: sign in with someone else’s password.');
      // The removed person may have kept the library key, so rotate it and re-encrypt everything.
      const raw2 = V.newLibraryKey(), key2 = await V.importLibraryKey(raw2);
      for (const [file, aad] of sealedFiles()) fs.writeFileSync(file, await V.seal(key2, await V.unseal(key, fs.readFileSync(file), aad), aad));
      for (const p of keep) {
        p.name = V.toB64(await V.seal(key2, await V.unseal(key, V.fromB64(p.name), V.label.name(p.id)), V.label.name(p.id)));
        p.box = await V.boxFor(p, raw2);
      }
      kr.people = keep;
      writeKeyring(kr);
      console.log('✓ ' + name + ' no longer has access. Library key rotated, files re-encrypted — commit docs/ and vault/.');
      return;
    }
    if (sub === 'passwd') {
      const kr = readKeyring();
      const old = await askPassword('Current password: ');
      const who = await V.signIn(kr, old, true);
      if (!who) fail('Wrong password.');
      let pw = await ask('New password (empty to generate): ', true);
      if (!pw) { pw = makePassword(); console.log('New password: ' + pw); }
      else if (pw.length < 12) fail('Too short: at least 12 characters. The keyring is public, so short passwords can be brute-forced.');
      else if (await ask('Repeat: ', true) !== pw) fail('Passwords do not match.');
      await V.repassword(who.person, old, pw, kr);
      writeKeyring(kr);
      console.log('✓ Password changed. Commit docs/keyring.json.');
      return;
    }
    fail('npm run user -- list | add <name> | remove <name> | passwd');
  },

  // Password-free validation: the site is complete and nothing in plaintext leaked. Also run by CI.
  async check() {
    const problems = [], bad = msg => problems.push(msg);
    let kr = null;
    try { kr = JSON.parse(fs.readFileSync(P.keyring, 'utf8')); } catch (e) { bad(rel(P.keyring) + ': ' + e.message); }
    if (kr) {
      if (kr.v !== 1 || !kr.kdf || !kr.kdf.salt || !(kr.kdf.iterations >= 100000)) bad('keyring.json: invalid header');
      if (!Array.isArray(kr.people) || !kr.people.length) bad('keyring.json: no people');
      else for (const p of kr.people) if (!p.id || !p.pub || !p.priv || !p.name || !p.box || !p.box.epk || !p.box.ct) bad('keyring.json: incomplete entry ' + (p.id || '?'));
    }
    const sealed = f => exists(f) && fs.statSync(f).size > 28;   // iv (12) + tag (16) + some payload
    if (!sealed(path.join(P.site, 'library.bin'))) bad('missing docs/library.bin');
    for (const page of ['index.html', 'lib/lock.js', 'lib/vault.js', 'lib/keystore.js', 'lib/style.css']) if (!exists(path.join(P.site, page))) bad('missing docs/' + page);
    const games = fs.readdirSync(P.site).filter(d => exists(path.join(P.site, d, 'game.bin')));
    for (const id of games) {
      const html = exists(path.join(P.site, id, 'index.html')) ? fs.readFileSync(path.join(P.site, id, 'index.html'), 'utf8') : '';
      if (!html) { bad('missing docs/' + id + '/index.html'); continue; }
      if (!sealed(path.join(P.site, id, 'game.bin'))) bad('docs/' + id + '/game.bin is empty');
      if (/\{\{\w+\}\}/.test(html)) bad('docs/' + id + '/index.html: unfilled template');
      const img = (html.match(/class="cover" src="([^"]+)"/) || [])[1];
      if (!img || !exists(path.join(P.site, id, img))) bad('docs/' + id + ': missing image ' + (img || ''));
      if (!exists(path.join(P.vault, id + '.bin'))) bad('vault/' + id + '.bin: missing encrypted sources');
    }
    for (const id of sourceIds()) if (!games.includes(id)) bad('vault/' + id + '.bin exists but docs/ has no such game');
    if (!games.length) bad('no games in docs/');
    // plaintext game files must never reach the repository or the site
    for (const f of walk(P.site)) if (/\.(m?js|css|html)$/.test(f) && !/^(index\.html|lib\/[\w-]+\.(js|css)|[\w-]+\/index\.html)$/.test(f)) bad('docs/' + f + ': looks like a plaintext game file');
    if (problems.length) { for (const p of problems) console.error('✗ ' + p); process.exit(1); }
    console.log('✓ docs/ is valid: ' + games.length + ' game(s), ' + kr.people.length + ' people');
  },

  async dev(what = 'games', port = '8000') {
    const dir = what === 'docs' ? P.site : P.games;
    if (!exists(dir)) fail('No ' + rel(dir) + (what === 'docs' ? '' : ' (run npm run unlock first)'));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
    http.createServer((req, res) => {
      let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(dir)) { res.writeHead(403).end(); return; }
      if (exists(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      if (!exists(p)) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'Content-Type': (types[path.extname(p)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    }).listen(+port, () => {
      console.log('http://localhost:' + port + '/');
      if (what !== 'docs') for (const id of gameIds()) console.log('  ' + id + ': http://localhost:' + port + '/' + id + '/');
    });
  }
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
(commands[cmd] || fail.bind(null, 'Unknown command: ' + cmd + '. See: node tools/cli.js help'))(...rest).catch(e => fail(e.stack || e));
