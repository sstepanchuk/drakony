#!/usr/bin/env node
/* Інструменти Ігротеки. Запуск: npm run <команда> (див. README або `node tools/cli.js help`).
   Пароль береться зі змінної VAULT_PASSWORD, а якщо її немає — питаємо. */
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

/* ---------- введення ---------- */
function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) rl._writeToOutput = s => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, answer => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}
const askPassword = (q = 'Пароль: ') => process.env.VAULT_PASSWORD || ask(q, true);

// пароль із 12 знаків без схожих літер (0/o, 1/l): ~60 біт випадковості
function makePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < 12) { const b = V.random(1)[0]; if (b < abc.length * 8) s += abc[b % abc.length]; }
  return s.match(/.{4}/g).join('-');
}

/* ---------- ключі ---------- */
const readKeyring = () => exists(P.keyring) ? JSON.parse(fs.readFileSync(P.keyring, 'utf8')) : fail('Немає ' + rel(P.keyring) + '. Почни з `node tools/cli.js init <ім’я> …`.');
const writeKeyring = kr => fs.writeFileSync(P.keyring, JSON.stringify(kr, null, 2) + '\n');

// вхід паролем: хто ти й ключ бібліотеки
async function signIn() {
  const kr = readKeyring();
  const who = await V.signIn(kr, await askPassword(), true);
  if (!who) fail('Не той пароль.');
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

/* ---------- зашифровані файли ---------- */
// пишемо, лише якщо вміст справді змінився: інакше кожне збирання міняло б усі файли
async function writeSealed(file, data, aad, key) {
  const plain = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (exists(file)) {
    try { if (eq(await V.unseal(key, fs.readFileSync(file), aad), plain)) return false; } catch (e) {}
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await V.seal(key, plain, aad));
  return true;
}
// усі зашифровані файли й їхні мітки (для зміни ключа)
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

/* ---------- вихідний код гри: тека → один архів ---------- */
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

/* ---------- збирання гри в одну сторінку ---------- */
async function bundleGame(dir) {
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  // стилі
  for (const m of [...html.matchAll(/<link rel="stylesheet" href="([^":]+)">/g)]) {
    const css = (await esbuild.transform(fs.readFileSync(path.join(dir, m[1]), 'utf8'), { loader: 'css', minify: true, charset: 'utf8' })).code;
    html = html.replace(m[0], () => '<style>' + css.trim() + '</style>');
  }
  // скрипти-модулі: збираємо в один звичайний скрипт
  for (const m of [...html.matchAll(/<script type="module" src="([^":]+)"><\/script>/g)]) {
    const r = await esbuild.build({ entryPoints: [path.join(dir, m[1])], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', charset: 'utf8', legalComments: 'none', logLevel: 'silent' });
    const js = r.outputFiles[0].text.trim();
    if (/<\/script/i.test(js)) fail('У зібраному коді трапився рядок </script, сторінку не можна вбудувати.');
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
    .replace(/\{\{(\w+)\}\}/g, (_, k) => k in vals ? esc(vals[k]) : fail('Шаблон: невідоме поле ' + k));
}

const gameIds = () => exists(P.games) ? fs.readdirSync(P.games).filter(id => exists(path.join(P.games, id, 'game.json'))).sort() : [];
const sourceIds = () => exists(P.vault) ? fs.readdirSync(P.vault).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)).sort() : [];

/* =====================================================================
   КОМАНДИ
   ===================================================================== */
const commands = {
  async help() {
    console.log(`Ігротека: команди

  npm run unlock                 розшифрувати вихідний код ігор у games/ (щоб редагувати)
  npm run dev [-- docs]          локальний сервер: games/ (або готовий сайт docs/)
  npm run check                  перевірити docs/ перед публікацією (без пароля)
  npm run build                  зібрати ігри, зашифрувати й покласти в docs/ і vault/

  npm run user -- list           хто має доступ
  npm run user -- add <ім'я>     додати людину (пароль буде створено й показано один раз)
  npm run user -- remove <ім'я>  прибрати людину (ключ бібліотеки зміниться, усе перешифрується)
  npm run user -- passwd         змінити свій пароль

  node tools/cli.js init <ім'я> …  створити нову бібліотеку (лише один раз)

Пароль можна передати змінною VAULT_PASSWORD.`);
  },

  async init(...names) {
    if (exists(P.keyring)) fail('Бібліотека вже існує: ' + rel(P.keyring));
    if (!names.length) fail('Вкажи хоча б одне ім’я: node tools/cli.js init <ім’я> …');
    const kr = V.newKeyring(), raw = V.newLibraryKey(), key = await V.importLibraryKey(raw);
    console.log('Нова бібліотека. Паролі показуються один раз, збережи їх:\n');
    for (const name of names) {
      const pw = makePassword();
      await addPerson(kr, key, raw, name, pw);
      console.log('  ' + name.padEnd(12) + pw);
    }
    writeKeyring(kr);
    console.log('\nДалі: npm run build');
  },

  async unlock(...flags) {
    const force = flags.includes('--force');
    const { key } = await signIn();
    for (const id of sourceIds()) {
      const files = unpackSource(await V.unseal(key, fs.readFileSync(path.join(P.vault, id + '.bin')), V.label.source(id)));
      const dir = path.join(P.games, id);
      const changed = Object.entries(files).filter(([f, b64]) => { const p = path.join(dir, f); return exists(p) && !eq(fs.readFileSync(p), Buffer.from(b64, 'base64')); });
      if (changed.length && !force) { console.log('! ' + id + ': локальні файли відрізняються (' + changed.map(c => c[0]).join(', ') + '), пропускаю. Перезаписати: npm run unlock -- --force'); continue; }
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
    if (missing.length) fail('Спершу розшифруй вихідний код (npm run unlock): немає games/' + missing.join(', games/'));
    if (!ids.length) fail('У games/ немає жодної гри.');
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
      console.log('✓ ' + id + ': гра ' + (html.length / 1024).toFixed(0) + ' КБ' + (wrote.some(Boolean) ? '' : ' (без змін)'));
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
      if (!name) fail('npm run user -- add <ім’я>');
      const { kr, key, raw } = await signIn();
      for (const p of kr.people) if (await nameOf(key, p) === name) fail('Таке ім’я вже є.');
      const pw = makePassword();
      await addPerson(kr, key, raw, name, pw);
      writeKeyring(kr);
      console.log('✓ ' + name + ' має доступ. Пароль (показується один раз): ' + pw);
      return;
    }
    if (sub === 'remove') {
      const name = args.join(' ');
      const { kr, me, key } = await signIn();
      const keep = [], gone = [];
      for (const p of kr.people) (await nameOf(key, p) === name ? gone : keep).push(p);
      if (!gone.length) fail('Немає такого імені. Дивись: npm run user -- list');
      if (gone.some(p => p.id === me.id)) fail('Себе прибрати не можна: увійди паролем іншої людини.');
      // Ця людина могла зберегти старий ключ бібліотеки, тож ключ міняємо й перешифровуємо все.
      const raw2 = V.newLibraryKey(), key2 = await V.importLibraryKey(raw2);
      for (const [file, aad] of sealedFiles()) fs.writeFileSync(file, await V.seal(key2, await V.unseal(key, fs.readFileSync(file), aad), aad));
      for (const p of keep) {
        p.name = V.toB64(await V.seal(key2, await V.unseal(key, V.fromB64(p.name), V.label.name(p.id)), V.label.name(p.id)));
        p.box = await V.boxFor(p, raw2);
      }
      kr.people = keep;
      writeKeyring(kr);
      console.log('✓ ' + name + ' більше не має доступу. Ключ бібліотеки змінено, файли перешифровано — закоміть docs/ і vault/.');
      return;
    }
    if (sub === 'passwd') {
      const kr = readKeyring();
      const old = await askPassword('Старий пароль: ');
      const who = await V.signIn(kr, old, true);
      if (!who) fail('Не той пароль.');
      let pw = await ask('Новий пароль (порожньо — згенерувати): ', true);
      if (!pw) { pw = makePassword(); console.log('Новий пароль: ' + pw); }
      else if (pw.length < 12) fail('Закороткий: щонайменше 12 знаків. Файл із ключами публічний, тож короткий пароль можна підібрати.');
      else if (await ask('Ще раз: ', true) !== pw) fail('Паролі не збігаються.');
      await V.repassword(who.person, old, pw, kr);
      writeKeyring(kr);
      console.log('✓ Пароль змінено. Закоміть docs/keyring.json.');
      return;
    }
    fail('npm run user -- list | add <ім’я> | remove <ім’я> | passwd');
  },

  // Перевірка без пароля: сайт цілий, нічого відкритого не просочилось. Її запускає й деплой.
  async check() {
    const problems = [], bad = msg => problems.push(msg);
    let kr = null;
    try { kr = JSON.parse(fs.readFileSync(P.keyring, 'utf8')); } catch (e) { bad(rel(P.keyring) + ': ' + e.message); }
    if (kr) {
      if (kr.v !== 1 || !kr.kdf || !kr.kdf.salt || !(kr.kdf.iterations >= 100000)) bad('keyring.json: неправильний заголовок');
      if (!Array.isArray(kr.people) || !kr.people.length) bad('keyring.json: немає жодної людини');
      else for (const p of kr.people) if (!p.id || !p.pub || !p.priv || !p.name || !p.box || !p.box.epk || !p.box.ct) bad('keyring.json: неповний запис ' + (p.id || '?'));
    }
    const sealed = f => exists(f) && fs.statSync(f).size > 28;   // iv (12) + тег (16) + хоч щось
    if (!sealed(path.join(P.site, 'library.bin'))) bad('немає docs/library.bin');
    for (const page of ['index.html', 'lib/lock.js', 'lib/vault.js', 'lib/keystore.js', 'lib/style.css']) if (!exists(path.join(P.site, page))) bad('немає docs/' + page);
    const games = fs.readdirSync(P.site).filter(d => exists(path.join(P.site, d, 'game.bin')));
    for (const id of games) {
      const html = exists(path.join(P.site, id, 'index.html')) ? fs.readFileSync(path.join(P.site, id, 'index.html'), 'utf8') : '';
      if (!html) { bad('немає docs/' + id + '/index.html'); continue; }
      if (!sealed(path.join(P.site, id, 'game.bin'))) bad('docs/' + id + '/game.bin порожній');
      if (/\{\{\w+\}\}/.test(html)) bad('docs/' + id + '/index.html: незаповнений шаблон');
      const img = (html.match(/class="cover" src="([^"]+)"/) || [])[1];
      if (!img || !exists(path.join(P.site, id, img))) bad('docs/' + id + ': немає картинки ' + (img || ''));
      if (!exists(path.join(P.vault, id + '.bin'))) bad('vault/' + id + '.bin: немає зашифрованого коду гри');
    }
    for (const id of sourceIds()) if (!games.includes(id)) bad('vault/' + id + '.bin є, а гри в docs/ немає');
    if (!games.length) bad('у docs/ немає жодної гри');
    // відкритий код ігор не має потрапити ні в репозиторій, ні на сайт
    for (const f of walk(P.site)) if (/\.(m?js|css|html)$/.test(f) && !/^(index\.html|lib\/[\w-]+\.(js|css)|[\w-]+\/index\.html)$/.test(f)) bad('docs/' + f + ': схоже на відкритий файл гри');
    if (problems.length) { for (const p of problems) console.error('✗ ' + p); process.exit(1); }
    console.log('✓ docs/ у порядку: ігор ' + games.length + ', людей ' + kr.people.length);
  },

  async dev(what = 'games', port = '8000') {
    const dir = what === 'docs' ? P.site : P.games;
    if (!exists(dir)) fail('Немає ' + rel(dir) + (what === 'docs' ? '' : ' (спершу npm run unlock)'));
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
(commands[cmd] || fail.bind(null, 'Невідома команда: ' + cmd + '. Дивись: node tools/cli.js help'))(...rest).catch(e => fail(e.stack || e));
