/**
 * ModelMaster lookup client — copy this one file into any app. No dependencies (uses fetch).
 *
 *   const mm = createModelMaster(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
 *   await mm.resolve('HP LaserJet M404dn')        // best match ≥ 0.7, or null
 *   await mm.lookup('Copystar CS 2552ci')         // ranked candidates
 *   await mm.lookupMany(rows.map(r => r.model))   // a whole usage report, in input order
 *   await mm.toners('MM-001389')                  // supplies; old (merged) keys still work
 *   await mm.model('MM-001389')                   // catalog row (specs, counts)
 *
 * Results are cached for the life of the client (names by name+manufacturer, models/toners by key).
 */

export interface Match {
  canonical_key: string; model_id: string; manufacturer: string | null; model: string; line: string | null
  generation: string | null; variant: string | null; confidence: number; method: 'alias' | 'model-number' | 'similar'
}
/** One input row of lookupMany. `match` is null when nothing matched. */
export interface BatchMatch {
  name: string; match: Match | null
  /** Top two candidates are within 0.05 of each other: worth a human look. */
  ambiguous: boolean
}
export interface Toner { canonical_key: string; type: string | null; color: string | null; sku: string; cost: number | null; yield_pages: number | null; source: string | null }

const MIN_CONFIDENCE = 0.7 // same bar as the database's resolve_model
const CHUNK = 500 // names per lookup_models call

export function createModelMaster(url: string, key: string) {
  const cache = new Map<string, Promise<any>>()
  const rpc = async <T>(fn: string, args: object): Promise<T> => {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!r.ok) throw new Error(`ModelMaster ${fn}: ${r.status} ${await r.text()}`)
    return r.json()
  }
  const once = <T>(k: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(k)) cache.set(k, load().catch((e) => (cache.delete(k), Promise.reject(e))))
    return cache.get(k)!
  }
  const nameKey = (name: string, mfr = '') => `n|${name.trim().toUpperCase()}|${mfr.trim().toUpperCase()}`
  const num = (m: any): Match => ({ ...m, confidence: Number(m.confidence) })

  const lookup = (name: string, mfr?: string, limit = 5): Promise<Match[]> =>
    once(`${nameKey(name, mfr)}|${limit}`, async () => (await rpc<any[]>('lookup_model', { p_name: name, p_mfr: mfr || null, p_limit: limit })).map(num))

  async function lookupMany(names: string[], mfrs?: (string | null | undefined)[]): Promise<BatchMatch[]> {
    const out: BatchMatch[] = new Array(names.length)
    const todo: number[] = []
    names.forEach((n, i) => (cache.has(nameKey(n, mfrs?.[i] ?? '') + '|batch') ? null : todo.push(i)))
    for (let s = 0; s < todo.length; s += CHUNK) {
      const part = todo.slice(s, s + CHUNK)
      const rows = await rpc<any[]>('lookup_models', { p_names: part.map((i) => names[i]), p_mfrs: mfrs ? part.map((i) => mfrs[i] ?? null) : null })
      rows.forEach((r, j) => {
        const i = part[j]
        const match = r.canonical_key ? num(r) : null
        const ambiguous = !!match && r.runner_up != null && match.confidence - Number(r.runner_up) < 0.05
        cache.set(nameKey(names[i], mfrs?.[i] ?? '') + '|batch', Promise.resolve({ match, ambiguous }))
      })
    }
    for (let i = 0; i < names.length; i++) out[i] = { name: names[i], ...(await cache.get(nameKey(names[i], mfrs?.[i] ?? '') + '|batch')) }
    return out
  }

  return {
    lookup,
    lookupMany,
    /** Best match if the database is reasonably sure (confidence ≥ 0.7), else null. */
    resolve: async (name: string, mfr?: string): Promise<Match | null> => {
      const [best] = await lookup(name, mfr)
      return best && best.confidence >= MIN_CONFIDENCE ? best : null
    },
    toners: (canonicalKey: string): Promise<Toner[]> => once(`t|${canonicalKey.trim().toUpperCase()}`, () => rpc('toners_for_key', { p_key: canonicalKey })),
    model: (canonicalKey: string): Promise<Record<string, any> | null> =>
      once(`m|${canonicalKey.trim().toUpperCase()}`, async () => (await rpc<any[]>('model_by_key', { p_key: canonicalKey }))[0] ?? null),
    clearCache: () => cache.clear(),
  }
}
