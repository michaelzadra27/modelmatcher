import { useMemo, useState } from 'react'
import { Bucket, ReconRow } from './lib/match'
import { actions } from './lib/store'
import { State, linkKey, modelLabel } from './lib/types'

const LABEL: Record<Bucket, string> = {
  resolved: 'Already matched',
  confident: 'Confident',
  review: 'Needs review',
  none: 'Not in master',
}

interface Edit {
  chosen?: string
  confirmed?: boolean
}

/**
 * Match every name from the non-master sources against the master model list.
 * Confident matches are pre-checked, near misses are pre-selected but unchecked,
 * and names with no candidate are the "not in master" to-do list.
 */
export default function ReconcileTab({ state, rows, goReview }: { state: State; rows: ReconRow[]; goReview: () => void }) {
  const [bucket, setBucket] = useState<Bucket>('confident')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(200)
  const [edits, setEdits] = useState<Record<string, Edit>>({})

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { resolved: 0, confident: 0, review: 0, none: 0 }
    rows.forEach((r) => c[r.bucket]++)
    return c
  }, [rows])
  const sources = [...new Set(rows.map((r) => r.source))]
  const ql = q.trim().toLowerCase()
  const shown = rows.filter((r) => r.bucket === bucket && (!source || r.source === source) && (!ql || r.raw.toLowerCase().includes(ql)))

  const key = (r: ReconRow) => linkKey(r.source, r.raw)
  const chosenOf = (r: ReconRow) => edits[key(r)]?.chosen ?? (r.bucket === 'none' ? '' : r.candidates[0]?.id ?? '')
  const confirmedOf = (r: ReconRow) => edits[key(r)]?.confirmed ?? (r.bucket === 'confident' && !!r.candidates[0])
  const ready = rows.filter((r) => r.bucket !== 'none' && confirmedOf(r) && chosenOf(r))
  const setRow = (r: ReconRow, patch: Edit) => setEdits((e) => ({ ...e, [key(r)]: { ...e[key(r)], ...patch } }))
  const modelName = (id: string) => {
    const c = state.canonicals.find((x) => x.id === id)
    return c ? modelLabel(c) : id
  }

  if (!rows.length)
    return <div className="card">Nothing to reconcile. Import another source (EA list, price book…) to match it against the master list.</div>

  return (
    <div style={{ paddingBottom: 70 }}>
      <div className="stats">
        {(['confident', 'review', 'none'] as Bucket[]).map((b) => (
          <div
            key={b}
            className="stat"
            style={{ cursor: 'pointer', outline: bucket === b ? '2px solid var(--accent)' : 'none' }}
            onClick={() => {
              setBucket(b)
              setLimit(200)
            }}
          >
            <b>{counts[b].toLocaleString()}</b>
            <span>{LABEL[b]}</span>
          </div>
        ))}
      </div>

      <div className="row">
        <select style={{ width: 200 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input style={{ width: 240 }} placeholder="Search names…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="mute">{shown.length.toLocaleString()} names</span>
        {bucket === 'none' && counts.none > 0 && (
          <>
            <div className="spacer" />
            <span className="mute">These are not in the master list.</span>
            <button className="btn" onClick={goReview}>
              Review as new models →
            </button>
          </>
        )}
      </div>

      <div className="list" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Match to master</th>
              <th></th>
              <th style={{ textAlign: 'center' }}>Confirm</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r) => {
              const chosen = chosenOf(r)
              const top = r.candidates.find((c) => c.id === chosen)
              return (
                <tr key={key(r)}>
                  <td>
                    <b>{r.raw}</b>
                    <br />
                    <small className="mute">
                      {r.mfr || '?'}
                      {r.variant && ` · variant ${r.variant}`}
                    </small>
                  </td>
                  <td className="mute">{r.source}</td>
                  <td>
                    <select value={chosen} onChange={(e) => setRow(r, { chosen: e.target.value, confirmed: e.target.value !== '' })}>
                      <option value="">— not in master —</option>
                      {r.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} · {c.id}{c.note ? ` (${c.note})` : ''}
                        </option>
                      ))}
                      {chosen && !r.candidates.some((c) => c.id === chosen) && <option value={chosen}>{modelName(chosen)}</option>}
                      <option disabled>──────────</option>
                      {state.canonicals
                        .filter((c) => !r.candidates.some((x) => x.id === c.id))
                        .slice(0, 400)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {modelLabel(c)} · {c.id}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>{top && <span className={'tag ' + (top.score >= 0.9 ? 'ok' : 'warn')}>{top.kind} {Math.round(top.score * 100)}%{top.note ? ` · ${top.note}` : ''}</span>}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={confirmedOf(r)} disabled={!chosen} onChange={(e) => setRow(r, { confirmed: e.target.checked })} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {shown.length > limit && (
          <div className="item" onClick={() => setLimit(limit + 400)}>
            Show more ({(shown.length - limit).toLocaleString()} left)…
          </div>
        )}
      </div>

      <div className="bar">
        <span className="mute">{ready.length.toLocaleString()} matches ready to confirm</span>
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={!ready.length}
          onClick={() => {
            actions.confirmMatches(ready.map((r) => ({ source: r.source, raw: r.raw, canonicalId: chosenOf(r) })))
            setEdits({})
          }}
        >
          Confirm {ready.length.toLocaleString()} match{ready.length === 1 ? '' : 'es'}
        </button>
      </div>
    </div>
  )
}
