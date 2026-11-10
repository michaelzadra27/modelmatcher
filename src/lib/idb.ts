// Minimal IndexedDB key-value store. The working state (thousands of models, aliases and BLI spec
// text) outgrows localStorage's ~5 MB quota, which fails silently; IndexedDB holds hundreds of MB.
const DB = 'modelmaster'
const STORE = 'kv'

let dbp: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        t.oncomplete = () => resolve(req.result as T)
        t.onerror = t.onabort = () => reject(t.error ?? req.error)
      })
  )
}

export const idbGet = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key))
export const idbSet = (key: string, value: unknown) => tx<void>('readwrite', (s) => s.put(value, key))
