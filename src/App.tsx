import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { InboxLanes, Member, inbox } from './lib/match'
import InboxTab from './Inbox'
import CaptureTab from './Capture'
import CatalogTab from './Catalog'
import ModelPicker from './ModelPicker'
import { actions, useModelState, useSaveError } from './lib/store'
import { CANON_FIELDS, Canonical, DeviceSpec, IGNORE, ROLE_LABEL, Role, SPEC_GROUPS, State, linkKey, modelLabel } from './lib/types'
import { parse } from './lib/normalize'
import { rowCtx } from './lib/match'
import { tonersForModel } from './lib/toner'
import { exportMaster } from './lib/workbook'
import { cloudConfigured, push, supabase } from './lib/cloud'
import { discardStuck, refresh, retryNow, useSyncStatus } from './lib/sync'

type Tab = 'import' | 'inbox' | 'master' | 'catalog' | 'capture' | 'cloud'

const TABS: Tab[] = ['inbox', 'catalog', 'master', 'capture', 'import', 'cloud']

export default function App() {
  const state = useModelState()
  const saveError = useSaveError()
  const sync = useSyncStatus()
  const [masterOpen, setMasterOpen] = useState<string | null>(null)
  // Names the user sent from "pick the right model" to "new models" (this session only).
  const [forceNew, setForceNew] = useState<Set<string>>(new Set())
  const box = useMemo(() => inbox(state, forceNew), [state.sources, state.canonicals, state.links, forceNew])
  const [tab, setTab] = useState<Tab>(() => (box.names ? 'inbox' : state.canonicals.length ? 'catalog' : 'import'))

  const doExport = () => {
    XLSX.writeFile(exportMaster(state), 'Model Master.xlsx')
  }

  const label = (t: Tab) =>
    t === 'inbox'
      ? `Inbox${box.names ? ` (${box.names.toLocaleString()})` : ''}`
      : t === 'master'
        ? `Master (${state.canonicals.length})`
        : t === 'cloud'
          ? 'Account'
          : t[0].toUpperCase() + t.slice(1)

  return (
    <>
      <header>
        <h1>Model Master</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {label(t)}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <SyncBadge go={() => setTab('cloud')} />
        <button className="btn primary" onClick={doExport} disabled={!Object.keys(state.sources).length && !state.canonicals.length}>
          Export workbook
        </button>
      </header>
      <main>
        {saveError && <div className="toast" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>{saveError}</div>}
        {cloudConfigured && !sync.canWrite && (
          <div className="warnbox">Read-only: you're not signed in, so you can look things up but not change them. <button className="linklike" onClick={() => setTab('cloud')}>Sign in</button></div>
        )}
        {sync.error && (
          <div className="warnbox">
            A change couldn't be saved to the cloud yet: {sync.error}. It's kept and retried automatically.{' '}
            <button className="linklike" onClick={retryNow}>Retry now</button>{' · '}
            <button className="linklike" onClick={() => confirm('Drop the change that keeps failing and reload from the cloud? That change is lost.') && discardStuck()}>Drop it and reload</button>
          </div>
        )}
        {state.pendingImport.length > 0 && tab !== 'import' && (
          <div className="warnbox">Imported sheet{state.pendingImport.length > 1 ? 's' : ''} not saved to the cloud yet: {state.pendingImport.join(', ')}. <button className="linklike" onClick={() => setTab('import')}>Review and save</button></div>
        )}
        {tab === 'import' && <ImportTab state={state} box={box} go={setTab} />}
        {tab === 'inbox' && <InboxTab state={state} box={box} sendToNew={(k) => setForceNew((s) => new Set(s).add(k))} goImport={() => setTab('import')} />}
        {tab === 'master' && <MasterTab key={masterOpen ?? ''} state={state} initialId={masterOpen} />}
        {tab === 'catalog' && <CatalogTab onEdit={(id) => { setMasterOpen(id); setTab('master') }} canEdit={(id) => state.canonicals.some((c) => c.id === id)} />}
        {tab === 'capture' && <CaptureTab state={state} />}
        {tab === 'cloud' && <CloudTab state={state} />}
      </main>
    </>
  )
}

/* ───────────────────────── Import ───────────────────────── */

function ImportTab({ state, box, go }: { state: State; box: InboxLanes; go: (t: Tab) => void }) {
  const [msg, setMsg] = useState('')
  const [auto, setAuto] = useState(0)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const take = async (files: FileList | File[]) => {
    setBusy(true)
    const r = await actions.importFiles([...files])
    setMsg(r.msg)
    setAuto(r.auto)
    setBusy(false)
  }
  const sources = Object.values(state.sources)
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
        </p>
        <label className="btn">
          Choose files…
          <input type="file" multiple accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files && take(e.target.files)} />
        </label>
      </div>
      {msg && (
        <div className="toast" style={{ marginTop: 12 }}>
          {msg}
          {auto > 0 && (
            <>
              {' '}
              <button
                className="linklike"
                onClick={() => {
                  const n = actions.undoAutoLinks()
                  setAuto(0)
                  setMsg(`${msg}\nUndid ${n.toLocaleString()} automatic links; those names are back in the Inbox.`)
                }}
              >
                Undo
              </button>
            </>
          )}
        </div>
      )}

      {state.pendingImport.length > 0 && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent)' }}>
          <b>Preview: not saved yet.</b>{' '}
          {state.pendingImport.map((n) => `${n} (${(state.sources[n]?.rows.length ?? 0).toLocaleString()} names)`).join(', ')}.
          <div className="mute" style={{ margin: '6px 0 10px' }}>
            Check the column roles below (and the Inbox if you like), then save. Until then only this browser has it; discarding reloads from the cloud.
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => { actions.saveImport(); setMsg('Saving the import to the cloud…'); setAuto(0) }}>Save to cloud</button>
            <button className="btn" onClick={() => confirm('Discard this import? Decisions made on these names since importing are lost too.') && actions.discardImport().then((ok) => setMsg(ok ? 'Import discarded.' : "Couldn't reload from the cloud (are you signed in?)."))}>Discard</button>
          </div>
        </div>
      )}

      {sources.length > 0 && (
        <>
          <div className="stats" style={{ marginTop: 16 }}>
            <Stat n={state.canonicals.length} label="Models" />
            <Stat n={aliasCount} label="Names linked to a model" />
            <Stat n={box.names} label="Names waiting in the Inbox" />
          </div>
          {box.names > 0 && (
            <div className="row">
              <button className="btn primary" onClick={() => go('inbox')}>Open the Inbox →</button>
            </div>
          )}

          <h3>Sheets & column roles</h3>
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
                    onClick={async () => {
                      const r = await actions.buildMaster(s.name)
                      setMsg(`Master list built from "${s.name}": ${r.created} models created${r.flagged ? `, ${r.flagged} groups left in the Inbox to check` : ''}. Names from other sheets are matched against these models.`)
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

/* ───────────────────────── Master ───────────────────────── */

function MasterTab({ state, initialId = null }: { state: State; initialId?: string | null }) {
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState<string | null>(initialId)
  const [limit, setLimit] = useState(500)

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
              {rows.slice(0, limit).map((c) => (
                <tr key={c.id} className="click" onClick={() => setEditId(c.id)}>
                  <td className="mute">{c.id}</td><td>{c.manufacturer}</td><td>{[c.model, c.generation].filter(Boolean).join(' ')}</td><td>{c.line}</td><td>{c.deviceType}</td>
                  <td>{stats.get(c.id)?.n ?? 0}</td><td>{stats.get(c.id)?.sources.size ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <div className="item" onClick={() => setLimit(limit + 1000)}>
              Showing {limit.toLocaleString()} of {rows.length.toLocaleString()} — show more…
            </div>
          )}
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

      {c.spec && (
        <div style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase' }}>
            BLI spec <span className="tag ok">captured</span>
          </h2>
          <div className="fields">
            {SPEC_GROUPS.flatMap((g) => g.fields)
              .filter((f) => (c.spec as DeviceSpec)[f.key])
              .map((f) => (
                <div key={f.key}>
                  <label>{f.label}</label>
                  <div style={{ padding: '4px 0' }}>{String((c.spec as DeviceSpec)[f.key])}</div>
                </div>
              ))}
          </div>
        </div>
      )}

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
              <tr><th>Color</th><th>Part / SKU</th><th>Cost</th><th>Yield</th><th>From</th></tr>
            </thead>
            <tbody>
              {toners.map((t, i) => (
                <tr key={i}>
                  <td>{t.color || '—'}</td>
                  <td title={t.raw !== t.sku ? `As written: ${t.raw}` : undefined}>{t.sku}</td>
                  <td className="mute">{t.cost != null ? `$${t.cost}` : '—'}</td>
                  <td className="mute">{t.yieldPages?.toLocaleString() ?? '—'}</td>
                  <td className="mute">{t.from}</td>
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
        <ModelPicker models={others} value={mergeTo} onPick={setMergeTo} placeholder="Merge this model into…" width={280} />
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

/* ───────────────────────── Save status + Account ───────────────────────── */

function SyncBadge({ go }: { go: () => void }) {
  const sync = useSyncStatus()
  if (!cloudConfigured) return null
  const [text, color] = !sync.canWrite
    ? ['Read-only', 'var(--mute)']
    : sync.error
      ? [`${sync.pending} change${sync.pending === 1 ? '' : 's'} not saved`, 'var(--bad)']
      : sync.saving || sync.pending
        ? ['Saving…', 'var(--mute)']
        : sync.refreshing
          ? ['Refreshing…', 'var(--mute)']
          : ['✓ All saved', 'var(--mute)']
  return (
    <button className="linklike" style={{ color, marginRight: 12 }} onClick={go} title="Changes save to the cloud as you make them">
      {text}
    </button>
  )
}

function CloudTab({ state }: { state: State }) {
  const sync = useSyncStatus()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  if (!cloudConfigured || !supabase)
    return (
      <div className="card">
        <h2>Connect Supabase</h2>
        <p>Copy <code>.env.example</code> to <code>.env.local</code>, fill in the project URL and publishable key, then restart the dev server.</p>
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

  if (!sync.canWrite)
    return (
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>Sign in</h2>
        <p className="mute">Signed out, ModelMaster is read-only. Sign in to make changes; they save to the cloud as you go.</p>
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
        <span>Signed in as <b>{sync.email}</b></span>
        <div className="spacer" />
        <button className="btn" onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </div>
      <p className="mute">
        Changes save to the cloud as you make them. This browser keeps a copy so screens are fast: {state.canonicals.length.toLocaleString()} models,{' '}
        {Object.values(state.sources).reduce((n, s) => n + s.rows.length, 0).toLocaleString()} names
        {sync.lastRefresh ? `, refreshed from the cloud ${new Date(sync.lastRefresh).toLocaleString()}` : ''}. It refreshes when the app opens and when you come back to the tab.
      </p>
      <div className="mute" style={{ marginBottom: 10 }}>
        {sync.error ? `⚠ ${sync.pending} change(s) waiting: ${sync.error}` : sync.pending ? `Saving ${sync.pending} change(s)…` : '✓ Everything is saved.'}
      </div>
      <div className="row">
        <button
          className="btn"
          disabled={busy || sync.refreshing}
          onClick={() => run(async () => ((await refresh()) ? 'Refreshed from the cloud.' : state.pendingImport.length ? 'Save or discard the import first.' : 'Not refreshed.'))}
        >
          {sync.refreshing ? 'Refreshing…' : 'Refresh from cloud'}
        </button>
      </div>
      {msg && <div className="toast">{msg}</div>}
      {err && <div className="warnbox">{err}</div>}
      <details style={{ marginTop: 16 }}>
        <summary className="mute">Advanced</summary>
        <p className="mute">
          Rewrite the whole cloud from this browser's copy (the old Push). Only for recovery: it overwrites anything changed elsewhere since this copy was refreshed.
        </p>
        <button
          className="btn danger"
          disabled={busy || sync.pending > 0}
          onClick={() =>
            confirm('Rewrite the whole cloud from this copy? Changes made elsewhere since your last refresh are undone.') &&
            run(async () => (await push(state, setMsg, { force: true })).msg)
          }
        >
          Full push (recovery)
        </button>
      </details>
    </div>
  )
}
