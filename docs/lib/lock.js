/* =====================================================================
   LOCK — shared by every library page: sign-in, remembering the device,
   fetching and decrypting content. User-facing text is Ukrainian.
   Page markup: #unlock (form), #pw (password), #err (error), #busy (progress).
   ===================================================================== */
import * as vault from './vault.js';
import * as device from './keystore.js';

const root = new URL('../', import.meta.url);        // site root (this folder is lib/)
const $ = id => document.getElementById(id);
const MSG = {
  offline: 'Не вдалося завантажити. Перевір інтернет і онови сторінку.',
  failed: 'Щось пішло не так. Перевір інтернет і спробуй ще.',
  wrong: 'Не той пароль.',
  game: 'Не вдалося відкрити гру. Онови сторінку.',
  library: 'Не вдалося відкрити бібліотеку. Онови сторінку.'
};

// no-cache: after a key rotation a cached old file would no longer decrypt
async function fetchBytes(path) {
  const r = await fetch(new URL(path, root), { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
// start a download now, read it later (keeps an early failure from being reported as unhandled)
function prefetch(path) {
  const p = fetchBytes(path);
  p.catch(() => {});
  return p;
}
let keyringP = null;
const keyring = () => keyringP || (keyringP = fetchBytes('keyring.json').then(b => JSON.parse(vault.text(b))));

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
  if (!key) await device.forget();                   // removed from the library, or the stored key is broken
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
  try {
    const key = await rememberedKey();
    if (key) return key;
  } catch (e) {
    busy.textContent = MSG.offline;
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
    try { key = await passwordKey(pw.value); } catch (x) { err.textContent = MSG.failed; }
    if (key) { pw.value = ''; resolve(key); return; }
    err.textContent ||= MSG.wrong;
    show('form');
    pw.select();
  }));
}

// unlock and decrypt a file that started downloading in parallel
async function openSealed(file, aad, failure) {
  const blob = prefetch(file);
  const key = await unlock();
  try { return vault.text(await vault.unseal(key, await blob, aad)); }
  catch (e) { $('busy').textContent = failure; $('busy').hidden = false; throw e; }
}

// page entry points: failures are already shown on the page, the console gets the details
const boot = fn => (...args) => fn(...args).catch(e => console.error(e));

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

export const bootLibrary = boot(async () => {
  const games = JSON.parse(await openSealed('library.bin', vault.label.library(), MSG.library));
  $('games').replaceChildren(...games.map(g => el('a', { className: 'game', href: g.id + '/' },
    el('img', { src: g.id + '/' + g.image, alt: '', loading: 'lazy' }),
    el('span', { className: 'game-body' }, el('b', { textContent: g.title }), el('span', { textContent: g.tagline }))
  )));
  $('lock').hidden = true;
  $('shelf').hidden = false;
  $('sign-out').addEventListener('click', async () => { await device.forget(); location.reload(); });
});
