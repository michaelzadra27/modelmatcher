// Parity check: the app's skuKey() (src/lib/sku.ts) must reduce a supply cell exactly as the
// database's mm_sku() (0006_sku_dedupe.sql) does, or the same cartridge is stored twice.
// Compares both on fixed edge cases plus every SKU stored in the live database (read through the
// model_toners view; the tables themselves need a signed-in user).
//   npm run check:sku
import fs from 'fs'
import { skuKey } from '../src/lib/sku'

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

const CASES = [
  'W2020A', 'HP 414A W2020A', 'w2020a', '3018C005AA', 'Canon 046 C/M/Y (1249C001/1248C001/1247C001)',
  'Ricoh MP 301 / 305+ Black Toner (841984)', 'GPR-58 C', 'TN-229V CMY', 'Brother TN331 Black', 'Dell 331-0719? – confirm',
  'Epson 502 (T502220/320/420-S)', 'Toner set (4 colors)', 'Kyocera TK-5282C', 'Canon PFI-1700 Ink Series', '', '  T502120  ',
  'Lexmark OEM toner for model – part # not confirmed', 'HP 937 (C/M/Y)', 'Priced by contract $', 'Xerox 106R01436',
]

async function mmSku(raw: string): Promise<string> {
  const r = await fetch(`${url}/rest/v1/rpc/mm_sku`, { method: 'POST', headers, body: JSON.stringify({ raw }) })
  if (!r.ok) throw new Error(`mm_sku: ${r.status} ${await r.text()}`)
  return r.json()
}

const live: string[] = []
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${url}/rest/v1/model_toners?select=sku&order=model_id,sku`, { headers: { ...headers, Range: `${from}-${from + 999}` } })
  if (!r.ok) throw new Error(`model_toners: ${r.status} ${await r.text()}`)
  const rows = (await r.json()) as { sku: string }[]
  live.push(...rows.map((x) => x.sku))
  if (rows.length < 1000) break
}
const inputs = [...new Set([...CASES, ...live])]

const bad: string[] = []
for (let i = 0; i < inputs.length; i += 25)
  await Promise.all(
    inputs.slice(i, i + 25).map(async (raw) => {
      const db = await mmSku(raw)
      const app = skuKey(raw)
      if (db !== app) bad.push(`  ${JSON.stringify(raw)}\n    app: ${JSON.stringify(app)}\n    db:  ${JSON.stringify(db)}`)
    })
  )

console.log(`Checked ${inputs.length} supply strings (${CASES.length} edge cases + ${new Set(live).size} live SKUs).`)
if (bad.length) {
  console.log(`${bad.length} MISMATCHES — keep src/lib/sku.ts and mm_sku() identical:\n${bad.join('\n')}`)
  process.exit(1)
}
console.log('skuKey() and mm_sku() agree on all of them.')
