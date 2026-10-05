/* =====================================================================
   REMEMBERING THIS DEVICE
   After sign-in the private key is kept in IndexedDB as a non-extractable CryptoKey: the page
   can use it, but nobody can read its bytes. The password is never stored. Without IndexedDB
   (some private windows) the key lives only until the tab closes.
   ===================================================================== */
const DB = 'ihroteka', STORE = 'keys', SLOT = 'me';
let memory = null;

function request(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(STORE, mode), req = op(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const quietly = p => p.catch(() => undefined);

export async function remember(id, priv) {
  memory = { id, priv };
  await quietly(request('readwrite', s => s.put(memory, SLOT)));
}
export async function recall() {
  return memory || (memory = (await quietly(request('readonly', s => s.get(SLOT)))) || null);
}
export async function forget() {
  memory = null;
  await quietly(request('readwrite', s => s.delete(SLOT)));
}
