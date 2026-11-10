import { useMemo, useState } from 'react'
import { Group, InboxLanes, Kind, ReconRow, similar, sureTarget } from './lib/match'
import { actions } from './lib/store'
import { CANON_FIELDS, IGNORE, State, linkKey, modelLabel } from './lib/types'
import ModelPicker from './ModelPicker'

/**
 * The one place names wait for a decision. Every name not yet linked to a model sits in exactly
 * one lane:
 *   matched — another way of writing a model you have (sure matches are linked at import; any
 *             left over are one click)
 *   pick    — close to one or more models, but not certain enough to link on its own
 *   new     — not in the catalog: grouped into proposed new models
 */
type Lane = 'matched' | 'pick' | 'new'

const WHY: Record<Kind, string> = {
  exact: 'same model number',
  truncation: 'same number, extra letters',
  core: 'same digits, different letters',
  contains: 'partial model number',
  fuzzy: 'similar wording',
}

export default function InboxTab({ state, box, sendToNew, goImport }: { state: State; box: InboxLanes; sendToNew: (key: string) => void; goImport: () => void }) {
  const newNames = box.groups.reduce((n, g) => n + g.members.length, 0)
  const counts: Record<Lane, number> = { matched: box.matched.length, pick: box.pick.length, new: newNames }
  const [lane, setLaneRaw] = useState<Lane>(() => (['matched', 'pick', 'new'] as Lane[]).find((l) => counts[l]) ?? 'matched')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  // If the open lane empties, move to the next one with work in it.
  const active = counts[lane] ? lane : (['matched', 'pick', 'new'] as Lane[]).find((l) => counts[l]) ?? lane
  const setLane = (l: Lane) => setLaneRaw(l)

  const sources = useMemo(
    () => [...new Set([...box.matched, ...box.pick].map((r) => r.source).concat(box.groups.flatMap((g) => g.sources)))].sort(),
    [box]
  )
  const ql = q.trim().toLowerCase()
  const rowOk = (r: { source: string; raw: string }) => (!source || r.source === source) && (!ql || r.raw.toLowerCase().includes(ql))

  const total = Object.values(state.sources).reduce((n, s) => n + s.rows.length, 0)
  const ignored = Object.values(state.links).filter((v) => v === IGNORE).length

  if (!box.names)
    return (
      <div className="card done">
        <div className="big">✓ Nothing waiting</div>
        <div className="mute">
          All {(total - ignored).toLocaleString()} names are linked to a model{ignored ? ` (${ignored.toLocaleString()} more ignored as not a device)` : ''}.
        </div>
        <div className="mute" style={{ marginTop: 4 }}>New names show up here when you import a sheet. Names that surely match a model you have are linked for you.</div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn primary" onClick={goImport}>Import a sheet</button>
        </div>
      </div>
    )

  const laneCard = (l: Lane, title: string, desc: string) => (
    <button key={l} className={'lane' + (active === l ? ' on' : '') + (counts[l] ? '' : ' empty')} onClick={() => setLane(l)}>
      <b>{counts[l].toLocaleString()}</b>
      <span className="t">{title}</span>
      <span className="d">{desc}</span>
    </button>
  )

  return (
    <div style={{ paddingBottom: 70 }}>
      <p className="mute" style={{ margin: '0 0 12px' }}>
        {box.names.toLocaleString()} name{box.names === 1 ? '' : 's'} from your sheets {box.names === 1 ? "isn't" : "aren't"} tied to a model yet. Each one needs one decision: which model it is, a new model, or not a device.
      </p>
      <div className="lanes">
        {laneCard('matched', 'Match a model you have', 'Another way of writing an existing model. Check and link.')}
        {laneCard('pick', 'Pick the right model', 'Close to one or more models, but not certain. Choose which.')}
        {laneCard('new', `New models${box.groups.length ? ` (${box.groups.length})` : ''}`, "Not in your catalog yet. Create them, or link if they're already there.")}
      </div>

      <div className="row">
        <select style={{ width: 200 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sheets</option>
          {sources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input style={{ width: 240 }} placeholder="Search names…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {active === 'matched' && <MatchedLane state={state} rows={box.matched.filter(rowOk)} />}
      {active === 'pick' && <PickLane state={state} rows={box.pick.filter(rowOk)} sendToNew={sendToNew} />}
      {active === 'new' && <NewLane state={state} groups={box.groups.filter((g) => g.members.some(rowOk))} />}
    </div>
  )
}

/* ── Lane 1: sure matches ── */

function MatchedLane({ state, rows }: { state: State; rows: ReconRow[] }) {
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [override, setOverride] = useState<Record<string, string>>({})
  const [limit, setLimit] = useState(200)
  const key = (r: ReconRow) => linkKey(r.source, r.raw)
  const target = (r: ReconRow) => override[key(r)] ?? sureTarget(r)
  const ready = rows.filter((r) => !skip.has(key(r)) && target(r))

  if (!rows.length) return <div className="card mute">No names in this lane match the filter.</div>

  return (
    <>
      <div className="list" style={{ maxHeight: 'none', overflow: 'visible' }}>
        <table>
          <thead>
            <tr><th style={{ width: 30 }}></th><th>Name in the sheet</th><th>Sheet</th><th>Is this model</th><th>Why</th><th></th></tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => {
              const k = key(r)
              const on = !skip.has(k)
              const top = r.candidates[0]
              return (
                <tr key={k} style={{ opacity: on ? 1 : 0.5 }}>
                  <td>
                    <input type="checkbox" checked={on} onChange={() => setSkip((s) => { const n = new Set(s); on ? n.add(k) : n.delete(k); return n })} />
                  </td>
                  <td><b>{r.raw}</b>{r.variant && <small className="mute"> · {r.variant}</small>}</td>
                  <td className="mute">{r.source}</td>
                  <td><ModelPicker models={state.canonicals} value={target(r)} onPick={(id) => setOverride((o) => ({ ...o, [k]: id }))} width={320} /></td>
                  <td className="mute">{override[k] ? 'chosen by you' : r.bucket === 'resolved' ? 'same name linked before' : top ? WHY[top.kind] : ''}</td>
                  <td><button className="linklike" onClick={() => actions.ignore([r])}>Not a device</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length > limit && <div className="item" onClick={() => setLimit(limit + 400)}>Show more ({(rows.length - limit).toLocaleString()} left)…</div>}
      </div>
      <div className="bar">
        <span className="mute">Untick any that are wrong, or change the model.</span>
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={!ready.length}
          onClick={() => {
            actions.confirmMatches(ready.map((r) => ({ source: r.source, raw: r.raw, canonicalId: target(r) })))
            setOverride({})
          }}
        >
          Link {ready.length.toLocaleString()} name{ready.length === 1 ? '' : 's'}
        </button>
      </div>
    </>
  )
}

/* ── Lane 2: a person picks ── */

function PickLane({ state, rows, sendToNew }: { state: State; rows: ReconRow[]; sendToNew: (key: string) => void }) {
  const [limit, setLimit] = useState(150)
  if (!rows.length) return <div className="card mute">No names in this lane match the filter.</div>
  return (
    <div className="list" style={{ maxHeight: 'none', overflow: 'visible' }}>
      <table>
        <thead>
          <tr><th>Name in the sheet</th><th>Is this…</th><th style={{ width: 300 }}>…or another model</th><th></th></tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => {
            const k = linkKey(r.source, r.raw)
            return (
              <tr key={k}>
                <td>
                  <b>{r.raw}</b>
                  <br />
                  <small className="mute">{r.source}{r.count > 1 ? ` · ${r.count} rows` : ''}{r.variant && ` · variant ${r.variant}`}</small>
                </td>
                <td>
                  <div className="choices">
                    {r.candidates.slice(0, 4).map((c) => (
                      <button key={c.id} className="btn" title={`${c.id} · ${WHY[c.kind]}${c.note ? ` · ${c.note}` : ''}`} onClick={() => actions.linkTo([r], c.id)}>
                        {c.label} <span className={c.score >= 0.9 ? '' : 'mute'}>{Math.round(c.score * 100)}%</span>
                        {c.note && <><br /><small className="mute">{c.note}</small></>}
                      </button>
                    ))}
                  </div>
                </td>
                <td><ModelPicker models={state.canonicals} onPick={(id) => actions.linkTo([r], id)} width={280} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="linklike" onClick={() => sendToNew(k)}>It's a new model</button>
                  <br />
                  <button className="linklike" onClick={() => actions.ignore([r])}>Not a device</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.length > limit && <div className="item" onClick={() => setLimit(limit + 300)}>Show more ({(rows.length - limit).toLocaleString()} left)…</div>}
    </div>
  )
}

/* ── Lane 3: new models ── */

function NewLane({ state, groups }: { state: State; groups: Group[] }) {
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [limit, setLimit] = useState(150)
  const shown = flaggedOnly ? groups.filter((g) => g.attention.length) : groups
  const current = groups.find((g) => g.id === sel) ?? shown[0] ?? null
  const bulk = shown.filter((g) => g.existingId || !g.attention.length)

  if (!groups.length) return <div className="card mute">No new models waiting.</div>

  return (
    <>
      <div className="row">
        <label className="row" style={{ margin: 0, gap: 4 }}>
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> Only ones that need a closer look
        </label>
        <div className="spacer" />
        <button
          className="btn"
          disabled={!bulk.length}
          title="Creates each proposed model as shown, skipping any flagged for a closer look"
          onClick={() => confirm(`Create ${bulk.length} models as proposed? Flagged ones are skipped.`) && actions.approveMany(bulk)}
        >
          Create {bulk.length} unflagged as proposed
        </button>
      </div>
      <div className="split">
        <div className="list">
          {shown.slice(0, limit).map((g) => (
            <div key={g.id} className={'item' + (current?.id === g.id ? ' on' : '')} onClick={() => setSel(g.id)}>
              <b>{g.existingId ? modelLabel(state.canonicals.find((c) => c.id === g.existingId) ?? g.draft) : modelLabel(g.draft)}</b>{' '}
              {g.existingId && <span className="tag ok">already exists</span>}
              {g.attention.length > 0 && <span className="tag warn">check</span>}
              <br />
              <small>{g.members.length} name{g.members.length === 1 ? '' : 's'} · {g.sources.join(', ')}</small>
            </div>
          ))}
          {shown.length > limit && <div className="item" onClick={() => setLimit(limit + 300)}>Show more ({shown.length - limit} left)…</div>}
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
  const existing = group.existingId ? state.canonicals.find((c) => c.id === group.existingId) : null
  const chosen = group.members.filter((m) => picked.has(linkKey(m.source, m.raw)))
  const allPicked = chosen.length === group.members.length
  const near = useMemo(() => similar(group, groups, state.canonicals).filter((n) => n.canonicalId), [group, groups, state.canonicals])
  const linkedCols = [...new Set(group.members.flatMap((m) => m.columns.filter((c) => state.sources[m.source].roles[c] === 'linked')))]
  const n = chosen.length
  const names = `${n} name${n === 1 ? '' : 's'}`

  const field = (f: (typeof CANON_FIELDS)[number]) => (
    <div key={f.key}>
      <label>{f.label}</label>
      <input value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
    </div>
  )

  return (
    <div className="card">
      {existing ? (
        <div className="detailhead">
          <div>
            <div className="heading">{modelLabel(existing)}</div>
            <div className="mute">Already in your catalog · {existing.id} · same model number</div>
          </div>
          <span className="tag ok">already exists</span>
        </div>
      ) : (
        <div className="detailhead">
          <div>
            <div className="heading">{modelLabel(draft) || 'New model'}</div>
            <div className="mute">
              {group.members.length} name{group.members.length === 1 ? '' : 's'} from {group.sources.join(', ')} that look like one model you don't have yet. Check the details, then create it.
            </div>
          </div>
          <span className="tag">gets a new MM- key</span>
        </div>
      )}

      {group.attention.map((a) => <div className="warnbox" key={a}>{a}</div>)}

      {!existing && (
        <>
          <div className="fields four">{IDENTITY_FIELDS.map(field)}</div>
          <button className="linklike" onClick={() => setShowSpecs((s) => !s)}>
            {showSpecs ? '▾ Hide specs' : '▸ Add specs (type, PPM, toner…)'}
          </button>
          {showSpecs && <div className="fields" style={{ marginTop: 8 }}>{SPEC_FIELDS.map(field)}</div>}
        </>
      )}

      <div className="row" style={{ margin: '14px 0 4px' }}>
        <b>Names in this model</b>
        <span className="mute">{chosen.length} of {group.members.length} selected</span>
        <div className="spacer" />
        <button className="linklike" onClick={() => setPicked(allPicked ? new Set() : new Set(group.members.map((m) => linkKey(m.source, m.raw))))}>
          {allPicked ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <table style={{ marginBottom: 14 }}>
        <thead>
          <tr>
            <th></th><th>Name</th><th>Variant</th><th>Sheet</th><th>Rows</th>
            {linkedCols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => {
            const k = linkKey(m.source, m.raw)
            const on = picked.has(k)
            return (
              <tr key={k} className="click" style={{ opacity: on ? 1 : 0.5 }} onClick={() => {
                const s = new Set(picked)
                on ? s.delete(k) : s.add(k)
                setPicked(s)
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

      <div className="row">
        <button className="btn primary" disabled={!n || (!existing && !draft.model.trim())} onClick={() => actions.approve(group, draft, chosen)}>
          {existing ? `Link ${names} to ${existing.model}` : `Create model + link ${names}`}
        </button>
        <button className="btn" disabled={!n} onClick={() => actions.ignore(chosen)}>Not a device — ignore</button>
      </div>

      {!existing && (
        <div className="altbox">
          <div className="mute" style={{ marginBottom: 6 }}>Already in your catalog under another name? Link the selected names to it instead:</div>
          {near.length > 0 && (
            <div className="row" style={{ marginBottom: 6 }}>
              {near.map((c) => (
                <button key={c.canonicalId} className="btn" disabled={!n} onClick={() => actions.linkTo(chosen, c.canonicalId!)}>
                  {c.label} <span className="mute">{Math.round(c.score * 100)}%</span>
                </button>
              ))}
            </div>
          )}
          <ModelPicker models={state.canonicals} onPick={(id) => n && actions.linkTo(chosen, id)} placeholder="Search any model to link to…" width={360} />
        </div>
      )}
    </div>
  )
}
