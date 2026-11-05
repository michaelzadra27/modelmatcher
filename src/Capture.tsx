import { useMemo, useState } from 'react'
import { CaptureResult, captureSpec } from './lib/bli/capture'
import { canonMfr } from './lib/normalize'
import { actions } from './lib/store'
import { DeviceSpec, SPEC_GROUPS, State, modelLabel } from './lib/types'

/**
 * Paste a BLI spec sheet → parse it client-side → match to an existing MM- key (or create one)
 * → review the fields → save. This folds the old PrinterAPI capture flow into ModelMaster.
 */
export default function CaptureTab({ state }: { state: State }) {
  const [text, setText] = useState('')
  const [cap, setCap] = useState<CaptureResult | null>(null)
  const [spec, setSpec] = useState<DeviceSpec | null>(null)
  const [target, setTarget] = useState<string>('') // '' = create new, else existing model id
  const [mfr, setMfr] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState('')

  const parse = () => {
    const c = captureSpec(text, state)
    setCap(c)
    setSpec(c.spec)
    setTarget(c.candidateId ?? '')
    setMfr(canonMfr(c.result.device.manufacturer ?? ''))
    setModel(c.result.device.model ?? '')
    setSaved('')
  }

  const candidate = cap?.candidateId ? state.canonicals.find((c) => c.id === cap.candidateId) : null

  const save = () => {
    if (!cap || !spec) return
    const identity = {
      manufacturer: mfr,
      model,
      line: '',
      generation: '',
      family: [mfr, model].filter(Boolean).join(' '),
      deviceType: spec.deviceClass,
      ppm: spec.speedPpm,
      color: spec.colorCapability,
      paper: spec.maxPaperSize,
      toner: '',
      notes: '',
    }
    const id = actions.saveCapture({ modelId: target || null, identity, spec, supplies: cap.supplies, name: cap.name })
    setSaved(`Saved to ${id}${target ? '' : ' (new model)'}.`)
    setCap(null)
    setSpec(null)
    setText('')
  }

  if (!cap || !spec)
    return (
      <div>
        <div className="card">
          <h2>Capture a BLI spec</h2>
          <p className="mute">Paste a BLI columnar spec export below. It's parsed in your browser, matched to a canonical model, then you review and save.</p>
          <textarea rows={14} style={{ fontFamily: 'monospace', fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full BLI spec sheet text here…" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!text.trim()} onClick={parse}>Parse</button>
            {saved && <span className="tag ok">{saved}</span>}
          </div>
        </div>
      </div>
    )

  const conf = Math.round((Number(spec.confidence) || 0) * 100)
  return (
    <div>
      <div className="card">
        <div className="detailhead">
          <div>
            <div className="heading">{[mfr, model].filter(Boolean).join(' ') || 'Parsed device'}</div>
            <div className="mute">Parse confidence {conf}% · {cap.result.supplies.length} supplies · {cap.result.unmappedKeys.length} extra fields</div>
          </div>
          <button className="btn" onClick={() => { setCap(null); setSpec(null) }}>Start over</button>
        </div>

        {/* Which model this spec belongs to */}
        <div className="altbox" style={{ marginBottom: 14 }}>
          <div className="row">
            <b>Attach to model</b>
            {candidate && cap.bucket !== 'none' && (
              <span className={'tag ' + (cap.bucket === 'confident' || cap.bucket === 'resolved' ? 'ok' : 'warn')}>
                match: {modelLabel(candidate)} · {candidate.id}
              </span>
            )}
          </div>
          <div className="row">
            <select style={{ width: 360 }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">➕ Create a new model</option>
              {state.canonicals.map((c) => (
                <option key={c.id} value={c.id}>{modelLabel(c)} · {c.id}</option>
              ))}
            </select>
            {!target && (
              <>
                <input style={{ width: 120 }} placeholder="Manufacturer" value={mfr} onChange={(e) => setMfr(e.target.value)} />
                <input style={{ width: 120 }} placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
              </>
            )}
          </div>
        </div>

        {/* Editable spec fields, grouped */}
        {SPEC_GROUPS.map((g) => (
          <div key={g.title} style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase', margin: '4px 0' }}>{g.title}</h2>
            <div className="fields">
              {g.fields.map((f) => (
                <div key={f.key}>
                  <label>{f.label}</label>
                  <input value={spec[f.key] as string} onChange={(e) => setSpec({ ...spec, [f.key]: e.target.value })} />
                </div>
              ))}
            </div>
          </div>
        ))}

        {cap.supplies.length > 0 && (
          <>
            <h2 style={{ fontSize: 12, color: 'var(--mute)', textTransform: 'uppercase' }}>Supplies ({cap.supplies.length})</h2>
            <table style={{ marginBottom: 12 }}>
              <thead><tr><th>Color</th><th>SKU</th><th>Cost</th><th>Yield</th><th>Type</th></tr></thead>
              <tbody>
                {cap.supplies.map((t, i) => (
                  <tr key={i}><td>{t.color || '—'}</td><td>{t.sku}</td><td className="mute">{t.cost != null ? `$${t.cost}` : '—'}</td><td className="mute">{t.yieldPages ?? '—'}</td><td className="mute">{t.type}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <ExtraFields spec={spec} />

        <div className="row">
          <button className="btn primary" disabled={!target && !model.trim()} onClick={save}>
            {target ? `Save spec to ${target}` : 'Create model + save spec'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ExtraFields({ spec }: { spec: DeviceSpec }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(
    () => Object.entries(spec.attributes).flatMap(([section, kv]) => Object.entries(kv).map(([k, v]) => ({ section, k, v }))),
    [spec.attributes]
  )
  if (!rows.length) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <button className="linklike" onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'} Extra parsed fields ({rows.length})</button>
      {open && (
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td className="mute">{r.section}</td><td>{r.k}</td><td>{r.v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
