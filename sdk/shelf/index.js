/* =====================================================================
   @ihroteka/shelf — the site: sign-in, remembering the device, fetching and decrypting
   content. Built into docs/lib/ihroteka.js together with its pages (index.html: the shelf,
   game.html: each game's public page). User-facing text is Ukrainian.
   Page markup: #unlock (form), #pw (password), #err (error), #busy (progress).
   ===================================================================== */
import * as vault from '../vault/index.js';
import * as device from './device.js';

window.__ihrotekaBooted = true;                      // the page's fallback timer checks this (see index.html)
const root = new URL('../', import.meta.url);        // site root (this folder is lib/)
const $ = id => document.getElementById(id);
const MSG = {
  offline: 'Не вдалося завантажити. Перевір інтернет і онови сторінку.',
  broken: 'Не вдалося завантажити бібліотеку. Онови сторінку трохи згодом.',
  insecure: 'Ця сторінка працює лише через https. Відкрий її за звичайним посиланням.',
  failed: 'Щось пішло не так. Перевір інтернет і спробуй ще.',
  wrong: 'Не той пароль.',
  updating: 'Бібліотеку щойно оновили. Спробуй за кілька хвилин.',
  game: 'Не вдалося відкрити гру. Онови сторінку.',
  library: 'Не вдалося відкрити бібліотеку. Онови сторінку.'
};
// fetch() rejects with TypeError only when the network itself failed
const offline = e => e instanceof TypeError;

/* ---------- downloads ---------- */
// no-cache: ask the server every time (after a key rotation an old copy would not decrypt);
// reload: also skip any cache on the way, for the one retry after a mismatch
async function fetchBytes(path, cache = 'no-cache') {
  const r = await fetch(new URL(path, root), { cache });
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
// start a download now, read it later (an early failure is not reported as unhandled)
function prefetch(path, cache) {
  const p = fetchBytes(path, cache);
  p.catch(() => {});
  return p;
}
let keyringP = null;
function keyring(cache) {
  if (!keyringP || cache) keyringP = fetchBytes('keyring.json', cache).then(b => JSON.parse(vault.text(b)));
  keyringP.catch(() => { keyringP = null; });         // a failed download is retried next time, not remembered
  return keyringP;
}

/* ---------- keys ---------- */
async function libraryKey(id, priv) {
  const raw = await vault.libraryKey(await keyring(), id, priv);
  return raw && vault.importKey(raw);
}
// key from what this device remembers; null → ask for the password
async function rememberedKey() {
  const me = await device.recall();
  if (!me) return null;
  await keyring();                                   // network errors propagate: never forget a key because we are offline
  const key = await libraryKey(me.id, me.priv).catch(() => null);
  if (!key) await device.forget();                   // removed from the library, or the stored key no longer fits
  return key;
}
async function passwordKey(password) {
  const who = await vault.signIn(await keyring(), password);
  if (!who) return null;
  await device.remember(who.person.id, who.priv);
  return libraryKey(who.person.id, who.priv);
}

// Shows the lock until the library key is known; resolves with it.
export async function unlock() {
  const form = $('unlock'), pw = $('pw'), err = $('err'), busy = $('busy');
  const show = state => { form.hidden = state !== 'form'; busy.hidden = state !== 'busy'; };
  show('busy');
  if (!globalThis.crypto?.subtle) { busy.textContent = MSG.insecure; throw new Error('no Web Crypto (insecure context?)'); }
  try {
    const key = await rememberedKey();
    if (key) return key;
  } catch (e) {
    busy.textContent = offline(e) ? MSG.offline : MSG.broken;
    throw e;
  }
  show('form');
  pw.focus();
  return new Promise(resolve => form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!pw.value) return;
    err.textContent = '';
    show('busy');
    let key = null;
    try { key = await passwordKey(pw.value); } catch (x) { err.textContent = offline(x) ? MSG.failed : MSG.broken; }
    if (key) { pw.value = ''; resolve(key); return; }
    if (!err.textContent) err.textContent = MSG.wrong;
    show('form');
    pw.select();
  }));
}

// Unlock and decrypt a file that started downloading in parallel. Right after a key rotation the server
// may briefly hand out the new keyring with an old file (or the other way round): then both are fetched
// again past every cache, once.
async function openSealed(file, aad, failure) {
  let blob = prefetch(file);
  for (let retry = false; ; retry = true) {
    const key = await unlock(), kr = await keyring();
    let data;
    try { data = await blob; } catch (e) { $('busy').textContent = offline(e) ? MSG.offline : failure; throw e; }
    if (vault.fileKid(data) === kr.kid) {
      try { return vault.text(await vault.openFile(key, data, aad)); }
      catch (e) { $('busy').textContent = failure; throw e; }
    }
    if (retry) { $('busy').textContent = MSG.updating; throw new Error(file + ': key id differs from keyring.json'); }
    blob = prefetch(file, 'reload');
    await keyring('reload').catch(() => {});
  }
}

// page entry points: failures are already shown on the page, the console gets the details
const boot = fn => (...args) => fn(...args).catch(e => { if ($('busy')) $('busy').hidden = false; console.error(e); });

/* ---------- game page ---------- */
export const bootGame = boot(async id => {
  const html = await openSealed(id + '/game.bin', vault.label.game(id), MSG.game);
  // the game replaces the whole page; the URL stays the same, so room links keep working
  document.open();
  document.write(html);
  document.close();
});

/* ---------- library page ---------- */
const el = (tag, props, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children); return n; };
const SHELF_MARK = 'ihroteka:shelf';                 // tells a game's home() that one step back is the shelf

export const bootLibrary = boot(async () => {
  const games = JSON.parse(await openSealed('library.bin', vault.label.library(), MSG.library));
  const here = location.href.split(/[?#]/)[0];
  $('games').replaceChildren(...games.map(g => el('a', { className: 'game', href: g.id + '/', onclick: () => { try { sessionStorage.setItem(SHELF_MARK, here); } catch (e) {} } },
    el('img', { src: g.id + '/' + g.image, alt: '', loading: 'lazy' }),
    el('span', { className: 'game-body' }, el('b', { textContent: g.title }), el('span', { textContent: g.tagline }))
  )));
  $('lock').hidden = true;
  $('shelf').hidden = false;
  $('sign-out').addEventListener('click', async () => { await device.forget(); location.reload(); });
});
