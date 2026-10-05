/* =====================================================================
   ЗАМОК
   Спільне для всіх сторінок бібліотеки: вхід паролем, запам'ятовування пристрою,
   завантаження й розшифрування вмісту.
   ===================================================================== */
import { signIn, libraryKey, unseal, label, toText } from './vault.js';
import { remember, recall, forget } from './keystore.js';

const root = new URL('../', import.meta.url);        // корінь сайту (ця тека — lib/)
const $ = id => document.getElementById(id);

async function fetchBytes(path) {
  const r = await fetch(new URL(path, root), { cache: 'no-cache' });   // після зміни ключів старий файл з кешу вже не відкриється
  if (!r.ok) throw new Error(path + ': ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
let keyringP = null;
const keyring = () => keyringP || (keyringP = fetchBytes('keyring.json').then(b => JSON.parse(toText(b))));

// ключ бібліотеки з того, що запам'ятав цей пристрій; null — треба пароль
async function savedKey() {
  const me = await recall();
  if (!me) return null;
  try {
    const k = await libraryKey(await keyring(), me.id, me.priv);
    if (k) return k.key;
  } catch (e) {}
  await forget();                                    // людину прибрали з бібліотеки або ключ зіпсований
  return null;
}
async function passwordKey(password) {
  const kr = await keyring();
  const who = await signIn(kr, password);
  if (!who) return null;
  await remember(who.person.id, who.priv);
  return (await libraryKey(kr, who.person.id, who.priv)).key;
}

export async function openSealed(key, path, aad) {
  return unseal(key, await fetchBytes(path), aad);
}

/* Показує замок і чекає на ключ бібліотеки. Розмітка замка — у самій сторінці:
   #unlock (форма), #pw (пароль), #err (помилка), #busy (напис «відмикаю»). */
export async function unlock() {
  const form = $('unlock'), pw = $('pw'), err = $('err'), busy = $('busy');
  const state = s => { form.hidden = s !== 'form'; busy.hidden = s !== 'busy'; };
  state('busy');
  try {
    const k = await savedKey();
    if (k) return k;
  } catch (e) {
    busy.textContent = 'Не вдалося завантажити. Перевір інтернет і онови сторінку.';
    throw e;
  }
  state('form');
  pw.focus();
  return new Promise(resolve => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!pw.value) return;
      err.textContent = '';
      state('busy');
      let k = null;
      try { k = await passwordKey(pw.value); } catch (x) { err.textContent = 'Щось пішло не так. Перевір інтернет і спробуй ще.'; }
      if (k) { pw.value = ''; resolve(k); return; }
      if (!err.textContent) err.textContent = 'Не той пароль.';
      state('form');
      pw.select();
    });
  });
}

export async function signOut() { await forget(); }

/* ---------- сторінка гри ---------- */
export async function bootGame(id) {
  const key = await unlock();
  let html;
  try { html = toText(await openSealed(key, id + '/game.bin', label.game(id))); }
  catch (e) {
    $('busy').textContent = 'Не вдалося відкрити гру. Онови сторінку.';
    $('busy').hidden = false;
    throw e;
  }
  // гра займає всю сторінку; адреса лишається та сама, тож посилання на кімнату працюють
  document.open();
  document.write(html);
  document.close();
}

/* ---------- сторінка бібліотеки ---------- */
export async function bootLibrary() {
  const key = await unlock();
  const games = JSON.parse(toText(await openSealed(key, 'library.bin', label.library())));
  const list = $('games');
  list.textContent = '';
  for (const g of games) {
    const a = document.createElement('a');
    a.className = 'game';
    a.href = g.id + '/';
    const img = document.createElement('img');
    img.src = g.id + '/' + g.image; img.alt = ''; img.loading = 'lazy';
    const body = document.createElement('span');
    body.className = 'game-body';
    const t = document.createElement('b'), d = document.createElement('span');
    t.textContent = g.title; d.textContent = g.tagline;
    body.append(t, d);
    a.append(img, body);
    list.appendChild(a);
  }
  $('lock').hidden = true;
  $('shelf').hidden = false;
  $('sign-out').addEventListener('click', async () => { await signOut(); location.reload(); });
}
