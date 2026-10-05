/* =====================================================================
   ЗАПАМ'ЯТОВУВАННЯ НА ЦЬОМУ ПРИСТРОЇ
   Після входу браузер зберігає твій приватний ключ як «невитягуваний»: сторінка може ним
   користуватись, але прочитати його байти не може ніхто, навіть вона сама. Пароль не зберігається.
   Якщо сховище недоступне (приватне вікно), ключ живе лише до закриття вкладки.
   ===================================================================== */
const DB = 'ihroteka', STORE = 'keys', SLOT = 'me';
let memory = null;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); res(q && q.result); };
    t.onerror = t.onabort = () => { d.close(); rej(t.error); };
  });
}

export async function remember(id, priv) {
  memory = { id, priv };
  try { await tx('readwrite', s => s.put(memory, SLOT)); } catch (e) {}
}
export async function recall() {
  if (memory) return memory;
  try { memory = (await tx('readonly', s => s.get(SLOT))) || null; } catch (e) {}
  return memory;
}
export async function forget() {
  memory = null;
  try { await tx('readwrite', s => s.delete(SLOT)); } catch (e) {}
}
