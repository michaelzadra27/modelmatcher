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
  { key: 'family', label: 'Family' },
  { key: 'deviceType', label: 'Device type' },
  { key: 'ppm', label: 'PPM' },
  { key: 'color', label: 'Color' },
  { key: 'paper', label: 'Paper size' },
  { key: 'toner', label: 'Toner family' },
  { key: 'notes', label: 'Notes' },
]

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
  deleted: string[] // canonical ids removed locally, still to be deleted in the cloud
}

export const emptyState = (): State => ({ sources: {}, canonicals: [], links: {}, log: [], deleted: [] })
export const linkKey = (source: string, raw: string) => `${source}\u0001${raw}`
