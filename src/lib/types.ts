// Column A of every source sheet is the model name. Other columns get a role.
export type Role = 'linked' | 'manufacturer' | 'family' | 'deviceType' | 'description' | 'supply' | 'price' | 'ignore'

export const ROLE_LABEL: Record<Role, string> = {
  linked: 'Linked data',
  supply: 'Toner / supply SKU',
  price: 'Price',
  manufacturer: 'Manufacturer',
  family: 'Model family',
  deviceType: 'Device type',
  description: 'Description (helps matching)',
  ignore: 'Ignore',
}

export interface Row {
  raw: string
  count: number // how many source rows collapsed into this unique name
  attrs: Record<string, string> // column → distinct values joined by "; "
}

export interface Source {
  name: string
  columns: string[] // all columns except column A
  roles: Record<string, Role>
  rows: Row[]
}

export interface Canonical {
  id: string
  manufacturer: string
  model: string
  line: string // product line, e.g. IR, IFORCE, LASERJET
  generation: string // II, III, IV or ''
  family: string
  deviceType: string
  ppm: string
  color: string
  paper: string
  toner: string
  notes: string
}

export const CANON_FIELDS: { key: keyof Canonical; label: string }[] = [
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'model', label: 'Canonical model' },
  { key: 'generation', label: 'Generation (II, III…)' },
  { key: 'line', label: 'Product line' },
  { key: 'family', label: 'Family' },
  { key: 'deviceType', label: 'Device type' },
  { key: 'ppm', label: 'PPM' },
  { key: 'color', label: 'Color' },
  { key: 'paper', label: 'Paper size' },
  { key: 'toner', label: 'Toner family' },
  { key: 'notes', label: 'Notes' },
]

export const fmtId = (n: number) => `MM-${String(n).padStart(6, '0')}`
export const idNumber = (id: string) => {
  const m = id.match(/^MM-(\d+)$/)
  return m ? Number(m[1]) : 0
}
export const modelLabel = (c: Pick<Canonical, 'manufacturer' | 'model' | 'generation'>) =>
  [c.manufacturer, c.model, c.generation].filter(Boolean).join(' ')

export const IGNORE = '__ignore__'

export interface LogEntry {
  date: string
  source: string
  raw: string
  decision: string
  canonicalId: string
}

export interface State {
  sources: Record<string, Source>
  canonicals: Canonical[]
  links: Record<string, string> // linkKey(source, raw) → canonical id | IGNORE
  log: LogEntry[]
  nextId: number // next MM-###### number to hand out; ids are never reused
  redirects: Record<string, string> // retired id → surviving id (after a merge)
  master: string // name of the source treated as the authoritative model list ('' = none)
  deleted: string[] // canonical ids removed locally, still to be deleted in the cloud
}

export const emptyState = (): State => ({ sources: {}, canonicals: [], links: {}, log: [], deleted: [], nextId: 1, redirects: {}, master: '' })
export const linkKey = (source: string, raw: string) => `${source}\u0001${raw}`
