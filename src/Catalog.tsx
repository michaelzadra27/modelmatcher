import { useEffect, useMemo, useRef, useState } from 'react'
import { specFromRow, supabase } from './lib/cloud'
import { SPEC_GROUPS } from './lib/types'

/**
 * Read-only browser over the live database (model_catalog / model_toners), i.e. exactly what other
 * apps see. Independent of the local working copy, so it never needs a Pull.
 */

const LIST_COLS =
  'id,canonical_key,manufacturer,model,line,generation,family,device_type,device_class,color,color_capability,paper_size,paper_size_class,ppm,speed_ppm,street_price,srp_price,manufacturing_status,has_spec,full_name,alias_count,variant_count,supply_count'
const PAGE = 100

type Row = Record<string, any>
type Sort = 'key' | 'name' | 'speed' | 'price'
const SORTS: Record<Sort, { label: string; apply: (q: any) => any }> = {
  name: { label: 'Manufacturer · model', apply: (q) => q.order('manufacturer', { nullsFirst: false }).order('model') },
  key: { label: 'MM key', apply: (q) => q.order('canonical_key') },
  speed: { label: 'Fastest first', apply: (q) => q.order('speed_ppm', { ascending: false, nullsFirst: false }).order('model') },
  price: { label: 'Street price ↑', apply: (q) => q.order('street_price', { ascending: true, nullsFirst: false }).order('model') },
}

const money = (v: unknown) => (v == null || v === '' ? '' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const clean = (s: string) => s.replace(/[,()"*\\:%]/g, ' ').trim()
const name = (r: Row) => [r.manufacturer, r.model, r.generation].filter(Boolean).join(' ')
const cls = (r: Row) => r.device_class ?? r.device_type ?? ''
const color = (r: Row) => r.color_capability ?? r.color ?? ''

export default function CatalogTab({ onEdit, canEdit }: { onEdit: (id: string) => void; canEdit: (id: string) => boolean }) {
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [f, setF] = useState({ mfr: '', cls: '', color: '', paper: '', status: '', spec: false, supplies: false })
  const [sort, setSort] = useState<Sort>('name')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Row[]>([])
  const [count, setCount] = useState(0)
  const [best, setBest] = useState<Row[]>([])
  const [mfrs, setMfrs] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const reqId = useRef(0)

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 250)
    return () => window.clearTimeout(t)
  }, [text])
  useEffect(() => setPage(0), [debounced, f, sort])

  useEffect(() => {
    supabase?.from('manufacturers').select('name').order('name').then(({ data }) => setMfrs((data ?? []).map((m: any) => m.name)))
  }, [])

  // The page of results.
  useEffect(() => {
    if (!supabase) return
    const id = ++reqId.current
    setLoading(true)
    let q: any = supabase.from('model_catalog').select(LIST_COLS, { count: 'exact' })
    if (f.mfr) q = q.eq('manufacturer', f.mfr)
    if (f.cls) q = q.eq('device_class', f.cls)
    if (f.color) q = q.eq('color_capability', f.color)
    if (f.paper) q = q.eq('paper_size_class', f.paper)
    if (f.status) q = q.eq('manufacturing_status', f.status)
    if (f.spec) q = q.eq('has_spec', true)
    if (f.supplies) q = q.gt('supply_count', 0)
    // Every word must appear somewhere in the key, brand, model, family or BLI name.
    for (const w of clean(debounced).split(/\s+/).filter(Boolean))
      q = q.or(['canonical_key', 'manufacturer', 'model', 'family', 'full_name'].map((c) => `${c}.ilike.*${w}*`).join(','))
    q = SORTS[sort].apply(q).range(page * PAGE, page * PAGE + PAGE - 1)
    q.then(({ data, count, error }: any) => {
      if (id !== reqId.current) return
      setLoading(false)
      setErr(error ? error.message : '')
      setRows(data ?? [])
      setCount(count ?? 0)
    })
  }, [debounced, f, sort, page])

  // "Best match": the same resolver other apps call, so "HP M454dw" finds the M454.
  useEffect(() => {
    const q = debounced.trim()
    if (!supabase || q.length < 3) return setBest([])
    let live = true
    supabase.rpc('lookup_model', { p_name: q, p_limit: 3 }).then(({ data }) => live && setBest((data as Row[]) ?? []))
    return () => {
      live = false
    }
  }, [debounced])

  if (!supabase) return <div className="card">The catalog reads from Supabase, which isn't configured in this build.</div>

  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }))
  const pages = Math.max(1, Math.ceil(count / PAGE))
  const anyFilter = text || Object.values(f).some(Boolean)

  return (
    <div className="split" style={{ gridTemplateColumns: openKey ? 'minmax(0,1fr) 520px' : 'minmax(0,1fr)' }}>
      <div>
        <div className="row filters">
          <input style={{ width: 300, maxWidth: '100%' }} placeholder="Search any name, e.g. HP M454dw or MM-001036" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <select value={f.mfr} onChange={(e) => set({ mfr: e.target.value })}>
            <option value="">All manufacturers</option>
            {mfrs.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={f.cls} onChange={(e) => set({ cls: e.target.value })}>
            <option value="">Any class</option>
            {['printer', 'mfp', 'copier', 'production', 'fax', 'scanner'].map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={f.color} onChange={(e) => set({ color: e.target.value })}>
            <option value="">Color or mono</option>
            <option value="color">color</option>
            <option value="mono">mono</option>
          </select>
          <select value={f.paper} onChange={(e) => set({ paper: e.target.value })}>
            <option value="">Any paper</option>
            <option>A3</option>
            <option>A4</option>
          </select>
          <select value={f.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any status</option>
            <option value="active">active</option>
            <option value="discontinued">discontinued</option>
          </select>
          <label className="mute"><input type="checkbox" checked={f.spec} onChange={(e) => set({ spec: e.target.checked })} /> BLI spec</label>
          <label className="mute"><input type="checkbox" checked={f.supplies} onChange={(e) => set({ supplies: e.target.checked })} /> has supplies</label>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
          {anyFilter && <button className="linklike" onClick={() => { setText(''); setF({ mfr: '', cls: '', color: '', paper: '', status: '', spec: false, supplies: false }) }}>Clear</button>}
        </div>
        {(f.cls || f.color || f.paper || f.status) && !f.spec && (
          <p className="mute" style={{ marginTop: -6 }}>Class, color, paper and status come from BLI specs, so these filters only find models that have one.</p>
        )}

        {best.length > 0 && (
          <div className="altbox" style={{ marginTop: 0, marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}><b>Best match for “{debounced.trim()}”</b><span className="mute">(the lookup other apps use)</span></div>
            <div className="row" style={{ marginBottom: 0 }}>
              {best.map((b) => (
                <button key={b.canonical_key} className="btn" onClick={() => setOpenKey(b.canonical_key)}>
                  {[b.manufacturer, b.model, b.generation].filter(Boolean).join(' ')}{b.variant ? ` (${b.variant})` : ''} · {b.canonical_key}
                  <span className={'tag ' + (b.confidence >= 0.85 ? 'ok' : b.confidence >= 0.7 ? '' : 'warn')}>{Math.round(b.confidence * 100)}% {b.method}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {err && <div className="toast" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>{err}</div>}
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="mute">{loading ? 'Loading…' : `${count.toLocaleString()} models`}</span>
          <div className="spacer" />
          {pages > 1 && (
            <>
              <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
              <span className="mute">Page {page + 1} of {pages}</span>
              <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
            </>
          )}
        </div>
        <div className="list" style={{ maxHeight: 'calc(100vh - 250px)' }}>
          <table>
            <thead>
              <tr><th>Key</th><th>Model</th><th>Class</th><th>Color</th><th>PPM</th><th>Paper</th><th>Street</th><th>Supplies</th><th>Names</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.canonical_key} className="click" style={openKey === r.canonical_key ? { background: 'var(--bg)' } : undefined} onClick={() => setOpenKey(r.canonical_key)}>
                  <td className="mute">{r.canonical_key}</td>
                  <td>
                    <b>{name(r)}</b>
                    {r.line && <span className="tag">{r.line}</span>}
                    {r.has_spec && <span className="tag ok">BLI</span>}
                    {r.full_name && <div className="mute" style={{ fontSize: 12 }}>{r.full_name}</div>}
                  </td>
                  <td>{cls(r)}</td>
                  <td>{color(r)}</td>
                  <td>{r.speed_ppm ?? r.ppm ?? ''}</td>
                  <td>{r.paper_size_class ?? ''}</td>
                  <td>{money(r.street_price)}</td>
                  <td>{r.supply_count || ''}</td>
                  <td>{r.alias_count || ''}</td>
                </tr>
              ))}
              {!loading && !rows.length && (
                <tr><td colSpan={9} className="mute">
                  {best.length ? `No stored name contains “${debounced.trim()}” — the best match above is what other apps would get.` : 'No models match.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {openKey && <DeviceDetail key={openKey} canonicalKey={openKey} close={() => setOpenKey(null)} onEdit={canEdit(openKey) ? onEdit : null} />}
    </div>
  )
}

function DeviceDetail({ canonicalKey, close, onEdit }: { canonicalKey: string; close: () => void; onEdit: ((id: string) => void) | null }) {
  const [m, setM] = useState<Row | null>(null)
  const [toners, setToners] = useState<Row[]>([])
  const [names, setNames] = useState<Row[] | null>(null) // null = not visible (signed out)
  const [variants, setVariants] = useState<string[]>([])
  const [showRaw, setShowRaw] = useState(false)
  const [showMore, setShowMore] = useState(false)

  useEffect(() => {
    const sb = supabase!
    sb.from('model_catalog').select('*').eq('canonical_key', canonicalKey).maybeSingle().then(({ data }) => {
      setM(data)
      if (!data) return
      sb.from('model_aliases').select('raw_name,sources(name)').eq('model_id', data.id).eq('status', 'linked').order('raw_name')
        .then(({ data: a, error }) => setNames(error || (!a?.length && data.alias_count) ? null : (a as Row[])))
      sb.from('model_variants').select('variant').eq('model_id', data.id).order('variant').then(({ data: v }) => setVariants((v ?? []).map((x: any) => x.variant)))
    })
    sb.from('model_toners').select('*').eq('canonical_key', canonicalKey).then(({ data }) => setToners(data ?? []))
  }, [canonicalKey])

  const spec = useMemo(() => (m?.has_spec ? specFromRow(m) : null), [m])
  const extra = useMemo(
    () => (spec ? Object.entries(spec.attributes ?? {}).flatMap(([section, kv]) => Object.entries(kv ?? {}).map(([k, v]) => ({ section, k, v: String(v) }))) : []),
    [spec]
  )
  const bySource = useMemo(() => {
    const g = new Map<string, string[]>()
    for (const a of names ?? []) {
      const s = a.sources?.name ?? '—'
      g.set(s, [...(g.get(s) ?? []), a.raw_name])
    }
    return [...g]
  }, [names])

  if (!m) return <div className="card">Loading {canonicalKey}…</div>

  const fmt = (k: string, v: string) => (/price/i.test(k) ? money(v) : v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v)
  return (
    <div className="card" style={{ position: 'sticky', top: 12, maxHeight: 'calc(100vh - 40px)', overflow: 'auto' }}>
      <div className="detailhead">
        <div style={{ flex: 1 }}>
          <div className="heading">{name(m)}</div>
          <div className="mute">{m.canonical_key}{m.full_name ? ` · ${m.full_name}` : ''}</div>
          <div style={{ marginTop: 6 }}>
            {m.line && <span className="tag" style={{ marginLeft: 0 }}>{m.line}</span>}
            {cls(m) && <span className="tag">{cls(m)}</span>}
            {color(m) && <span className="tag">{color(m)}</span>}
            {m.paper_size_class && <span className="tag">{m.paper_size_class}</span>}
            {m.manufacturing_status && <span className={'tag ' + (m.manufacturing_status === 'active' ? 'ok' : 'warn')}>{m.manufacturing_status}</span>}
            {!m.has_spec && <span className="tag warn">no BLI spec</span>}
          </div>
        </div>
        {onEdit ? <button className="btn" onClick={() => onEdit(m.canonical_key)}>Edit in Master</button> : <span className="mute" style={{ fontSize: 12 }} title="Pull on the Cloud tab to edit it here">not in your working copy</span>}
        <button className="btn" onClick={close}>✕</button>
      </div>

      {spec &&
        SPEC_GROUPS.map((g) => {
          const fields = g.fields.filter((x) => spec[x.key] && x.key !== 'fullName')
          if (!fields.length) return null
          return (
            <div key={g.title} style={{ marginBottom: 12 }}>
              <h2>{g.title}</h2>
              <table><tbody>
                {fields.map((x) => <tr key={x.key}><td className="mute" style={{ width: 190 }}>{x.label}</td><td>{fmt(x.key, String(spec[x.key]))}</td></tr>)}
              </tbody></table>
            </div>
          )
        })}

      <h2>Supplies ({toners.length})</h2>
      {toners.length ? (
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>Color</th><th>SKU</th><th>Type</th><th>Cost</th><th>Yield</th><th>¢/page</th><th>Source</th></tr></thead>
          <tbody>
            {toners.map((t, i) => (
              <tr key={i}>
                <td>{t.color}</td><td>{t.sku}</td><td className="mute">{t.type}</td><td>{money(t.cost)}</td>
                <td>{t.yield_pages ? Number(t.yield_pages).toLocaleString() : ''}</td>
                <td>{t.cost && t.yield_pages ? ((t.cost / t.yield_pages) * 100).toFixed(2) : ''}</td>
                <td className="mute">{t.source ?? 'BLI'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="mute">No supplies linked.</p>}

      <h2>Known names ({m.alias_count}){variants.length ? ` · variants ${variants.join(', ')}` : ''}</h2>
      {names === null ? (
        <p className="mute">Sign in on the Cloud tab to see the names linked to this model.</p>
      ) : bySource.length ? (
        <table style={{ marginBottom: 12 }}><tbody>
          {bySource.map(([s, list]) => <tr key={s}><td className="mute" style={{ width: 150 }}>{s}</td><td>{list.join(' · ')}</td></tr>)}
        </tbody></table>
      ) : <p className="mute">None yet.</p>}

      {extra.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button className="linklike" onClick={() => setShowMore((o) => !o)}>{showMore ? '▾' : '▸'} More BLI fields ({extra.length})</button>
          {showMore && <table><tbody>{extra.map((r, i) => <tr key={i}><td className="mute">{r.section}</td><td>{r.k}</td><td>{r.v}</td></tr>)}</tbody></table>}
        </div>
      )}
      {m.raw_spec && (
        <div>
          <button className="linklike" onClick={() => setShowRaw((o) => !o)}>{showRaw ? '▾' : '▸'} Original BLI text</button>
          {showRaw && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 300, overflow: 'auto' }}>{m.raw_spec}</pre>}
        </div>
      )}
    </div>
  )
}
