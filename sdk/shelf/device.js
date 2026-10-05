/* =====================================================================
   REMEMBERING THIS DEVICE
   After sign-in the private key is kept in IndexedDB as a non-extractable CryptoKey: the page
   can use it, but nobody can read its bytes. The password is never stored.
   Without IndexedDB (some private windows) nothing is remembered between pages: the password
   is asked again on every page. Anything else served from the same origin could use the stored
   key too, so the site must not host or load untrusted code (see README, Security).
   ===================================================================== */
const DB = 'ihroteka', STORE = 'keys', SLOT = 'me', TIMEOUT = 3000;
let memory = null;

// One request in its own transaction. Never hangs: Safari sometimes leaves indexedDB.open without any
// answer (e.g. after the tab comes back), so after TIMEOUT it gives up as if the storage were empty.
function request(mode, op) {
  const job = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = open.onblocked = () => reject(open.error || new Error('IndexedDB blocked'));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(STORE, mode), req = op(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      } catch (e) { db.close(); reject(e); }
    };
  });
  const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error('IndexedDB timeout')), TIMEOUT));
  return Promise.race([job, timeout]).catch(() => undefined);   // storage trouble = nothing remembered
}

export async function remember(id, priv) {
  memory = { id, priv };
  if (globalThis.indexedDB) await request('readwrite', s => s.put(memory, SLOT));
}
export async function recall() {
  if (!memory && globalThis.indexedDB) memory = (await request('readonly', s => s.get(SLOT))) || null;
  return memory;
}
export async function forget() {
  memory = null;
  if (globalThis.indexedDB) await request('readwrite', s => s.delete(SLOT));
}
