import { useMemo, useState } from 'react'
import { Canonical, modelLabel } from './lib/types'

/**
 * Type-to-search model chooser (manufacturer, model, line or MM- key), for lists far too long
 * for a dropdown. Shows the chosen model's name when not being typed into.
 */
export default function ModelPicker({
  models,
  value = '',
  onPick,
  placeholder = 'Search models…',
  width = 300,
}: {
  models: Canonical[]
  value?: string
  onPick: (id: string) => void
  placeholder?: string
  width?: number | string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const index = useMemo(() => models.map((c) => ({ c, text: `${c.id} ${modelLabel(c)} ${c.line} ${c.family}`.toLowerCase() })), [models])
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hits = (words.length ? index.filter((x) => words.every((w) => x.text.includes(w))) : index).slice(0, 40)
  const chosen = value ? models.find((c) => c.id === value) : undefined

  const pick = (id: string) => {
    onPick(id)
    setOpen(false)
    setQ('')
  }

  return (
    <div className="picker" style={{ width }}>
      <input
        placeholder={placeholder}
        value={open ? q : chosen ? `${modelLabel(chosen)} · ${chosen.id}` : ''}
        onFocus={() => {
          setOpen(true)
          setQ('')
          setHi(0)
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value)
          setHi(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, hits.length - 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)))
          else if (e.key === 'Enter' && hits[hi]) (e.preventDefault(), pick(hits[hi].c.id), (e.target as HTMLInputElement).blur())
          else if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        }}
      />
      {open && (
        <div className="menu">
          {hits.length ? (
            hits.map((x, i) => (
              <div key={x.c.id} className={'opt' + (i === hi ? ' on' : '')} onMouseDown={(e) => (e.preventDefault(), pick(x.c.id))} onMouseEnter={() => setHi(i)}>
                {modelLabel(x.c)} {x.c.line && <small className="mute">({x.c.line})</small>} <small className="mute">· {x.c.id}</small>
              </div>
            ))
          ) : (
            <div className="opt mute">No model matches “{q}”</div>
          )}
        </div>
      )}
    </div>
  )
}
