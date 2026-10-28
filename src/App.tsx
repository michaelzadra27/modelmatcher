import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { Group, Member, proposeGroups, reconcile, similar } from './lib/match'
import ReconcileTab from './Reconcile'
import { actions, useModelState } from './lib/store'
import { CANON_FIELDS, Canonical, IGNORE, ROLE_LABEL, Role, State, linkKey, modelLabel } from './lib/types'
import { parse } from './lib/normalize'
import { rowCtx } from './lib/match'
import { tonersForModel } from './lib/toner'
import { exportMaster } from './lib/workbook'
import { cloudConfigured, pull, push, supabase } from './lib/cloud'

type Tab = 'import' | 'reconcile' | 'review' | 'master' | 'cloud'

export default function App() {
  const state = useModelState()
  const [tab, setTab] = useState<Tab>(Object.keys(state.sources).length ? 'review' : 'import')
  const groups = useMemo(() => proposeGroups(state), [state.sources, state.canonicals, state.links])
  const recon = useMemo(() => (state.master ? reconcile(state) : []), [state.sources, state.canonicals, state.links, state.master])

  const doExport = () => {
    XLSX.writeFile(exportMaster(state), 'Model Master.xlsx')
  }

  return (
    <>
      <header>
        <h1>Model Master</h1>
        <nav>
          {((state.master ? ['import', 'reconcile', 'review', 'master', 'cloud'] : ['import', 'review', 'master', 'cloud']) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'import' ? 'Import' : t === 'cloud' ? 'Cloud' : t === 'reconcile' ? `Reconcile (${recon.filter((r) => r.bucket !== 'none').length})` : t === 'review' ? `Review (${groups.length})` : `Master (${state.canonicals.length})`}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn primary" onClick={doExport} disabled={!Object.keys(state.sources).length && !state.canonicals.length}>
          Export workbook
        </button>
      </header>
      <main>
        {tab === 'import' && <ImportTab state={state} groups={groups} go={setTab} />}
        {tab === 'reconcile' && <ReconcileTab state={state} rows={recon} goReview={() => setTab('review')} />}
        {tab === 'review' && <ReviewTab state={state} groups={groups} />}
        {tab === 'master' && <MasterTab state={state} />}
        {tab === 'cloud' && <CloudTab state={state} />}
      </main>
    </>
  )
}

/* ───────────────────────── Import ───────────────────────── */

function ImportTab({ state, groups, go }: { state: State; groups: Group[]; go: (t: Tab) => void }) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const take = async (files: FileList | File[]) => {
    setBusy(true)
    setMsg(await actions.importFiles([...files]))
    setBusy(false)
  }
  const sources = Object.values(state.sources)
  const autoLinks = groups.filter((g) => g.existingId)
  const newGroups = groups.filter((g) => !g.existingId)
  const unresolved = groups.filter((g) => g.attention.length)
  const aliasCount = Object.values(state.links).filter((v) => v !== IGNORE).length

  return (
    <>
      <div
        className={'drop' + (over ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(e.dataTransfer.files)
        }}
      >
        <p style={{ margin: '0 0 10px' }}>
          {busy ? 'Reading…' : 'Drop an Excel workbook here. Each tab becomes a source; column A is the model name.'}
          <br />
          Drop a previously exported <b>Model Master.xlsx</b> to continue from where you left off.
        </p>
        <label className="btn">
          Choose files…
          <input type="file" multiple accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files && take(e.target.files)} />
        </label>
      </div>
      {msg && <div className="toast" style={{ marginTop: 12 }}>{msg}</div>}

      {sources.length > 0 && (
        <>
          <h3>What's new</h3>
          <div className="stats">
            <Stat n={state.canonicals.length} label="Canonical models" />
            <Stat n={aliasCount} label="Aliases linked" />
            <Stat n={autoLinks.length} label="Match existing models" />
            <Stat n={newGroups.length} label="New model groups" />
            <Stat n={unresolved.length} label="Need attention" />
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => go('review')}>Go to review</button>
            {autoLinks.length > 0 && (
              <button className="btn" onClick={() => actions.approveMany(autoLinks)}>
                Auto-link {autoLinks.length} groups that match existing models
              </button>
            )}
          </div>

          <h3>Sources & column roles</h3>
          {sources.map((s) => (
            <div className="card" key={s.name}>
              <div className="row" style={{ marginBottom: 6 }}>
                <b>{s.name}</b>
                {state.master === s.name && <span className="tag ok">Master list</span>}
                <span className="mute">{s.rows.length.toLocaleString()} unique models · column A = model name</span>
                <div className="spacer" />
                {state.master === s.name ? (
                  <button className="btn" onClick={() => actions.clearMaster()}>Not the master</button>
                ) : (
                  <button
                    className="btn"
                    onClick={() => {
                      const r = actions.buildMaster(s.name)
                      setMsg(`Master list built from "${s.name}": ${r.created} models created${r.flagged ? `, ${r.flagged} groups flagged for review` : ''}. Import other sources next, then reconcile them.`)
                    }}
                  >
                    Use as master list
                  </button>
                )}
                <button className="btn danger" onClick={() => confirm(`Remove source "${s.name}" and its links?`) && actions.removeSource(s.name)}>
                  Remove
                </button>
              </div>
              <table>
                <tbody>
                  {s.columns.map((c) => (
                    <tr key={c}>
                      <td style={{ width: 240 }}>{c}</td>
                      <td style={{ width: 260 }}>
                        <select value={s.roles[c]} onChange={(e) => actions.setRole(s.name, c, e.target.value as Role)}>
                          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="mute">e.g. {s.rows.find((r) => r.attrs[c])?.attrs[c] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <button className="btn danger" onClick={() => confirm('Clear everything in this browser? Export first if you need it.') && actions.reset()}>
            Clear all data
          </button>
        </>
      )}
    </>
  )
}

const Stat = ({ n, label }: { n: number; label: string }) => (
  <div className="stat">
    <b>{n.toLocaleString()}</b>
    <span>{label}</span>
  </div>
)

/* ───────────────────────── Review ───────────────────────── */

type Filter = 'all' | 'existing' | 'new' | 'attention' | 'clean'

function ReviewTab({ state, groups }: { state: State; groups: Group[] }) {
  const [filter, setFilter] = useState<Filter>('new')
  const [mfr, setMfr] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [limit, setLimit] = useState(150)

  const mfrs = useMemo(() => [...new Set(groups.map((g) => g.mfr || '(unknown)'))].sort(), [groups])
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return groups.filter((g) => {
      if (filter === 'existing' && !g.existingId) return false
      if (filter === 'new' && g.existingId) return false
      if (filter === 'attention' && !g.attention.length) return false
      if (filter === 'clean' && (g.attention.length || g.existingId)) return false
      if (mfr && (g.mfr || '(unknown)') !== mfr) return false
      if (ql && !g.members.some((m) => m.raw.toLowerCase().includes(ql)) && !g.base.toLowerCase().includes(ql)) return false
      return true
    })
  }, [groups, filter, mfr, q])

  const current = groups.find((g) => g.id === sel) ?? shown[0] ?? null
  const bulk = shown.filter((g) => g.existingId || !g.attention.length)

  if (!groups.length)
    return <div className="card">{Object.keys(state.sources).length ? 'Nothing left to review. Export your workbook.' : 'Import a workbook first.'}</div>

  return (
    <>
      <div className="row">
        <select style={{ width: 190 }} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All groups</option>
          <option value="new">New models</option>
          <option value="existing">Match existing models</option>
          <option value="clean">New, no flags</option>
          <option value="attention">Needs attention</option>
        </select>
        <select style={{ width: 160 }} value={mfr} onChange={(e) => setMfr(e.target.value)}>
          <option value="">All manufacturers</option>
          {mfrs.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input style={{ width: 220 }} placeholder="Search names…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="mute">{shown.length} groups</span>
        <div className="spacer" />
        <button
          className="btn"
          disabled={!bulk.length}
          onClick={() => confirm(`Approve ${bulk.length} unflagged groups as proposed?`) && actions.approveMany(bulk)}
        >
          Approve {bulk.length} unflagged
        </button>
      </div>
      <div className="split">
        <div className="list">
          {shown.slice(0, limit).map((g) => (
            <div key={g.id} className={'item' + (current?.id === g.id ? ' on' : '')} onClick={() => setSel(g.id)}>
              <b>{g.existingId ? modelLabel(state.canonicals.find((c) => c.id === g.existingId) ?? g.draft) : modelLabel(g.draft)}</b>{' '}
              <small>{g.mfr || '?'}</small>
              {g.existingId && <span className="tag ok">existing</span>}
              {g.attention.length > 0 && <span className="tag warn">check</span>}
              <br />
              <small>
                {g.members.length} names · {g.sources.join(', ')}
              </small>
            </div>
          ))}
          {shown.length > limit && (
            <div className="item" onClick={() => setLimit(limit + 300)}>Show more ({shown.length - limit} left)…</div>
          )}
        </div>
        {current ? <GroupDetail key={current.id} group={current} groups={groups} state={state} /> : <div className="card">No groups match.</div>}
      </div>
    </>
  )
}

const IDENTITY_FIELDS = CANON_FIELDS.filter((f) => ['manufacturer', 'model', 'generation', 'line'].includes(f.key))
const SPEC_FIELDS = CANON_FIELDS.filter((f) => !['manufacturer', 'model', 'generation', 'line'].includes(f.key))

function GroupDetail({ group, groups, state }: { group: Group; groups: Group[]; state: State }) {
  const [draft, setDraft] = useState(group.draft)
  const [picked, setPicked] = useState(() => new Set(group.members.map((m) => linkKey(m.source, m.raw))))
  const [showSpecs, setShowSpecs] = useState(false)
  const [target, setTarget] = useState('')
  const existing = group.existingId ? state.canonicals.find((c) => c.id === group.existingId) : null
  const chosen = group.members.filter((m) => picked.has(linkKey(m.source, m.raw)))
  const allPicked = chosen.length === group.members.length
  const near = useMemo(() => similar(group, groups, state.canonicals).filter((n) => n.canonicalId), [group, groups, state.canonicals])
  const linkedCols = [...new Set(group.members.flatMap((m) => m.columns.filter((c) => state.sources[m.source].roles[c] === 'linked')))]

  const field = (f: (typeof CANON_FIELDS)[number]) => (
    <div key={f.key}>
      <label>{f.label}</label>
      <input value={draft[f.key as keyof typeof draft]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
    </div>
  )

  return (
    <div className="card">
      {/* Header: what this group is and what will happen */}
      {existing ? (
        <div className="detailhead">
          <div>
            <div className="heading">{modelLabel(existing)}</div>
            <div className="mute">
              Matches an existing model · {existing.id} · {group.matchedBy === 'alias' ? 'name already linked before' : 'same model number'}
            </div>
          </div>
          <span className="tag ok">existing</span>
        </div>
      ) : (
        <div className="detailhead">
          <div>
            <div className="heading">{modelLabel(draft) || 'New model'}</div>
            <div className="mute">
              {group.members.length} name{group.members.length === 1 ? '' : 's'} from {group.sources.join(', ')} — looks like one new model. Confirm the details, then create it.
            </div>
          </div>
          <span className="tag">gets a new MM- key</span>
        </div>
      )}

      {group.attention.map((a) => <div className="warnbox" key={a}>{a}</div>)}

      {/* Identity: the fields that define the key */}
      {!existing && (
        <>
          <div className="fields four">{IDENTITY_FIELDS.map(field)}</div>
          <button className="linklike" onClick={() => setShowSpecs((s) => !s)}>
            {showSpecs ? '▾ Hide specs' : '▸ Add specs (type, PPM, toner…)'}
          </button>
          {showSpecs && <div className="fields" style={{ marginTop: 8 }}>{SPEC_FIELDS.map(field)}</div>}
        </>
      )}

      {/* Which names belong */}
      <div className="row" style={{ margin: '14px 0 4px' }}>
        <b>Names in this model</b>
        <span className="mute">{chosen.length} of {group.members.length} selected</span>
        <div className="spacer" />
        <button
          className="linklike"
          onClick={() => setPicked(allPicked ? new Set() : new Set(group.members.map((m) => linkKey(m.source, m.raw))))}
        >
          {allPicked ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <table style={{ marginBottom: 14 }}>
        <thead>
          <tr>
            <th></th><th>Name</th><th>Variant</th><th>Source</th><th>Rows</th>
            {linkedCols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => {
            const k = linkKey(m.source, m.raw)
            const on = picked.has(k)
            return (
              <tr key={k} className="click" style={{ opacity: on ? 1 : 0.5 }} onClick={() => {
                const n = new Set(picked)
                on ? n.delete(k) : n.add(k)
                setPicked(n)
              }}>
                <td><input type="checkbox" checked={on} readOnly /></td>
                <td><b>{m.raw}</b></td>
                <td className="mute">{m.variant || '—'}</td>
                <td className="mute">{m.source}</td>
                <td className="mute">{m.count}</td>
                {linkedCols.map((c) => <td key={c} className="mute">{m.attrs[c] ?? ''}</td>)}
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Primary action */}
      <div className="row">
        <button className="btn primary" disabled={!chosen.length || (!existing && !draft.model.trim())} onClick={() => actions.approve(group, draft, chosen)}>
          {existing ? `Link ${chosen.length} name${chosen.length === 1 ? '' : 's'} to ${existing.model}` : `Create model + link ${chosen.length} name${chosen.length === 1 ? '' : 's'}`}
        </button>
        <button className="btn" disabled={!chosen.length} onClick={() => actions.ignore(chosen)}>Not a device — ignore</button>
      </div>

      {/* Already exists? Link to another model instead */}
      {!existing && (
        <div className="altbox">
          <div className="mute" style={{ marginBottom: 6 }}>Actually an existing model? Link the selected names instead of creating a new one:</div>
          {near.length > 0 && (
            <div className="row" style={{ marginBottom: 6 }}>
              {near.map((n) => (
                <button key={n.canonicalId} className="btn" disabled={!chosen.length} onClick={() => actions.linkTo(chosen, n.canonicalId!)}>
                  {n.label} <span className="mute">{Math.round(n.score * 100)}%</span>
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <select style={{ width: 300 }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Pick any existing model…</option>
              {state.canonicals.map((c) => (
                <option key={c.id} value={c.id}>{modelLabel(c)} · {c.id}</option>
              ))}
            </select>
            <button className="btn" disabled={!target || !chosen.length} onClick={() => actions.linkTo(chosen, target)}>Link</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── Master ───────────────────────── */

function MasterTab({ state }: { state: State }) {
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState<string | null>(null)

  const stats = useMemo(() => {
    const m = new Map<string, { n: number; sources: Set<string> }>()
    for (const s of Object.values(state.sources))
      for (const r of s.rows) {
        const l = state.links[linkKey(s.name, r.raw)]
        if (!l || l === IGNORE) continue
        const e = m.get(l) ?? { n: 0, sources: new Set() }
        e.n++
        e.sources.add(s.name)
        m.set(l, e)
      }
    return m
  }, [state.sources, state.links])

  const ql = q.trim().toLowerCase()
  const rows = state.canonicals.filter((c) => !ql || `${c.id} ${modelLabel(c)} ${c.line} ${c.family} ${c.deviceType}`.toLowerCase().includes(ql))
  const editing = state.canonicals.find((c) => c.id === editId)

  if (!state.canonicals.length) return <div className="card">No canonical models yet. Approve groups in Review.</div>

  return (
    <div className="split" style={{ gridTemplateColumns: editing ? '1fr 460px' : '1fr' }}>
      <div>
        <div className="row">
          <input style={{ width: 260 }} placeholder="Search master…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="mute">{rows.length} models</span>
        </div>
        <div className="list" style={{ maxHeight: 'calc(100vh - 160px)' }}>
          <table>
            <thead>
              <tr><th>ID</th><th>Manufacturer</th><th>Model</th><th>Line</th><th>Type</th><th>Aliases</th><th>Sources</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((c) => (
                <tr key={c.id} className="click" onClick={() => setEditId(c.id)}>
                  <td className="mute">{c.id}</td><td>{c.manufacturer}</td><td>{[c.model, c.generation].filter(Boolean).join(' ')}</td><td>{c.line}</td><td>{c.deviceType}</td>
                  <td>{stats.get(c.id)?.n ?? 0}</td><td>{stats.get(c.id)?.sources.size ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <CanonicalEditor key={editing.id} c={editing} state={state} close={() => setEditId(null)} />}
    </div>
  )
}

function CanonicalEditor({ c, state, close }: { c: Canonical; state: State; close: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [mergeTo, setMergeTo] = useState('')
  const aliases: (Member & { key: string })[] = []
  for (const s of Object.values(state.sources))
    for (const r of s.rows)
      if (state.links[linkKey(s.name, r.raw)] === c.id) {
        const ctx = rowCtx(s, r)
        aliases.push({
          key: linkKey(s.name, r.raw),
          source: s.name,
          raw: r.raw,
          count: r.count,
          variant: parse(r.raw, { mfr: ctx.mfr, desc: ctx.desc }).variant,
          attrs: r.attrs,
          columns: s.columns,
          ctx,
        })
      }
  const variants = new Map<string, number>()
  aliases.forEach((a) => variants.set(a.variant || '(none)', (variants.get(a.variant || '(none)') ?? 0) + 1))
  const toners = tonersForModel(state, c.id)
  const others = state.canonicals.filter((x) => x.id !== c.id && x.manufacturer === c.manufacturer)
  const retired = Object.entries(state.redirects).filter(([, to]) => to === c.id).map(([from]) => from)

  return (
    <div className="card">
      <div className="row">
        <b>{modelLabel(c)}</b>
        <span className="tag">{c.id}</span>
        <div className="spacer" />
        <button className="btn" onClick={close}>Close</button>
      </div>
      {retired.length > 0 && <div className="mute" style={{ marginBottom: 10 }}>Also answers to retired ids: {retired.join(', ')}</div>}
      <div className="fields">
        {CANON_FIELDS.map((f) => (
          <div key={f.key}>
            <label>{f.label}</label>
            <input value={c[f.key] ?? ''} onChange={(e) => actions.updateCanonical(c.id, { [f.key]: e.target.value })} />
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase' }}>Variants</h2>
      <div className="row">
        {[...variants.entries()].map(([v, n]) => (
          <span key={v} className="tag">{v} · {n}</span>
        ))}
      </div>

      {toners.length > 0 && (
        <>
          <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase' }}>Toners ({toners.length})</h2>
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr><th>Color</th><th>SKU</th><th>Cost</th><th>Yield</th></tr>
            </thead>
            <tbody>
              {toners.map((t, i) => (
                <tr key={i}>
                  <td>{t.color || '—'}</td>
                  <td>{t.sku}</td>
                  <td className="mute">{t.cost != null ? `$${t.cost}` : '—'}</td>
                  <td className="mute">{t.yieldPages ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase' }}>Aliases ({aliases.length})</h2>
      <table>
        <tbody>
          {aliases.map((a) => (
            <tr key={a.key}>
              <td style={{ width: 24 }}>
                <input
                  type="checkbox"
                  checked={picked.has(a.key)}
                  onChange={(e) => {
                    const n = new Set(picked)
                    e.target.checked ? n.add(a.key) : n.delete(a.key)
                    setPicked(n)
                  }}
                />
              </td>
              <td>{a.raw}</td>
              <td className="mute">{a.variant}</td>
              <td className="mute">{a.source}</td>
              <td><button className="btn" onClick={() => actions.unlink(a.source, a.raw)}>Unlink</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn"
          disabled={!picked.size}
          title="Moves the ticked names into a new model with its own id (e.g. when a generation was lumped in)"
          onClick={() => {
            actions.splitAliases(c.id, aliases.filter((a) => picked.has(a.key)))
            setPicked(new Set())
          }}
        >
          Split {picked.size || ''} ticked into a new model
        </button>
      </div>
      <div className="row">
        <select style={{ width: 260 }} value={mergeTo} onChange={(e) => setMergeTo(e.target.value)}>
          <option value="">Merge this model into…</option>
          {others.map((x) => (
            <option key={x.id} value={x.id}>{modelLabel(x)} {x.line && `(${x.line})`} · {x.id}</option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!mergeTo}
          onClick={() => confirm(`Merge ${c.id} into ${mergeTo}? ${c.id} keeps resolving to ${mergeTo}.`) && (actions.mergeCanonicals(c.id, mergeTo), close())}
        >
          Merge
        </button>
        <div className="spacer" />
        <button
          className="btn danger"
          onClick={() => confirm(`Delete ${c.id}? Its aliases go back to the review queue.`) && (actions.deleteCanonical(c.id), close())}
        >
          Delete model
        </button>
      </div>
    </div>
  )
}

/* ───────────────────────── Cloud (Supabase) ───────────────────────── */

function CloudTab({ state }: { state: State }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user.email ?? null))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user.email ?? null))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!cloudConfigured || !supabase)
    return (
      <div className="card">
        <h2>Connect Supabase</h2>
        <ol>
          <li>Create a Supabase project and run <code>supabase/migrations/0001_init.sql</code> in the SQL editor.</li>
          <li>Authentication → Users → add a user (email + password) for yourself.</li>
          <li>Copy <code>.env.example</code> to <code>.env.local</code> and fill in the project URL and <b>anon</b> key (Project Settings → API), then restart the dev server.</li>
        </ol>
      </div>
    )

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setErr('')
    try {
      setMsg(await fn())
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }

  if (!user)
    return (
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>Sign in</h2>
        <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { error } = await supabase!.auth.signInWithPassword({ email, password })
              if (error) throw error
              return 'Signed in'
            })
          }
        >
          Sign in
        </button>
        {err && <div className="warnbox" style={{ marginTop: 12 }}>{err}</div>}
      </div>
    )

  return (
    <div className="card">
      <div className="row">
        <span>Signed in as <b>{user}</b></span>
        <div className="spacer" />
        <button className="btn" onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </div>
      <p className="mute">
        Local: {state.canonicals.length.toLocaleString()} models, {Object.values(state.sources).reduce((n, s) => n + s.rows.length, 0).toLocaleString()} names.
        Push saves everything (safe to repeat). Pull replaces your local working state with what is in the cloud.
      </p>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => run(() => push(state, setMsg))}>Push to cloud</button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            confirm('Replace local data with the cloud copy? Unpushed local work is lost.') &&
            run(async () => {
              const next = await pull(setMsg)
              actions.replace(next)
              return `Pulled ${next.canonicals.length} models and ${Object.values(next.sources).reduce((n, s) => n + s.rows.length, 0).toLocaleString()} names.`
            })
          }
        >
          Pull from cloud
        </button>
      </div>
      {msg && <div className="toast">{msg}</div>}
      {err && <div className="warnbox">{err}</div>}
    </div>
  )
}
