// Column A of every source sheet is the model name. Other columns get a role.
export type Role =
  | 'linked'
  | 'manufacturer'
  | 'family'
  | 'deviceType'
  | 'description'
  | 'supply'
  | 'price'
  | 'tonerBlackSku'
  | 'tonerBlackCost'
  | 'tonerBlackYield'
  | 'tonerColorSku'
  | 'tonerColorCost'
  | 'tonerColorYield'
  | 'ignore'

export const ROLE_LABEL: Record<Role, string> = {
  linked: 'Linked data',
  tonerBlackSku: 'Black toner — SKU',
  tonerBlackCost: 'Black toner — cost',
  tonerBlackYield: 'Black toner — yield',
  tonerColorSku: 'Color toner — SKU(s)',
  tonerColorCost: 'Color toner — cost',
  tonerColorYield: 'Color toner — yield',
  supply: 'Other supply SKU',
  price: 'Device price',
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
  spec?: DeviceSpec // BLI-captured device specs (optional; present once captured)
}

// BLI device spec fields. All strings for simple editing; booleans as 'yes' | 'no' | ''.
export interface DeviceSpec {
  fullName: string
  deviceClass: string
  colorCapability: string
  technology: string
  partNumber: string
  streetPrice: string
  srpPrice: string
  introDate: string
  manufacturingStatus: string
  discontinuedDate: string
  estimatedEndOfSupport: string
  speedPpm: string
  speedRaw: string
  firstCopyOutSec: string
  scanSpeedSimplexBlack: string
  scanSpeedSimplexColor: string
  scanSpeedDuplexBlack: string
  scanSpeedDuplexColor: string
  documentFeeder: string
  scannerFeederType: string
  faxCapable: string
  hasEthernet: string
  hasWifi: string
  hasNfc: string
  networkInterfaceRaw: string
  maxPaperSize: string
  paperSizeClass: string
  confidence: string
  rawSpec: string
  attributes: Record<string, Record<string, string>> // long-tail, section → key → value
}

// Grouped for the capture/detail UI.
export const SPEC_GROUPS: { title: string; fields: { key: keyof DeviceSpec; label: string }[] }[] = [
  {
    title: 'Identity',
    fields: [
      { key: 'fullName', label: 'Full name' },
      { key: 'deviceClass', label: 'Device class' },
      { key: 'colorCapability', label: 'Color' },
      { key: 'technology', label: 'Technology' },
    ],
  },
  {
    title: 'SKU · Pricing · Lifecycle',
    fields: [
      { key: 'partNumber', label: 'Part number' },
      { key: 'streetPrice', label: 'Street price' },
      { key: 'srpPrice', label: 'SRP' },
      { key: 'introDate', label: 'Intro date' },
      { key: 'manufacturingStatus', label: 'Status' },
      { key: 'discontinuedDate', label: 'Discontinued' },
      { key: 'estimatedEndOfSupport', label: 'Est. end of support' },
    ],
  },
  {
    title: 'Performance',
    fields: [
      { key: 'speedPpm', label: 'Speed (PPM)' },
      { key: 'speedRaw', label: 'Speed (raw)' },
      { key: 'firstCopyOutSec', label: 'First copy out (sec)' },
      { key: 'scanSpeedSimplexBlack', label: 'Scan simplex black (ipm)' },
      { key: 'scanSpeedSimplexColor', label: 'Scan simplex color (ipm)' },
      { key: 'scanSpeedDuplexBlack', label: 'Scan duplex black (ipm)' },
      { key: 'scanSpeedDuplexColor', label: 'Scan duplex color (ipm)' },
      { key: 'documentFeeder', label: 'Document feeder' },
      { key: 'scannerFeederType', label: 'Feeder type' },
    ],
  },
  {
    title: 'Connectivity',
    fields: [
      { key: 'faxCapable', label: 'Fax' },
      { key: 'hasEthernet', label: 'Ethernet' },
      { key: 'hasWifi', label: 'Wi-Fi' },
      { key: 'hasNfc', label: 'NFC' },
      { key: 'networkInterfaceRaw', label: 'Network (raw)' },
    ],
  },
  {
    title: 'Paper',
    fields: [
      { key: 'maxPaperSize', label: 'Max paper size' },
      { key: 'paperSizeClass', label: 'Paper class' },
    ],
  },
]

export const emptySpec = (): DeviceSpec => ({
  fullName: '', deviceClass: '', colorCapability: '', technology: '', partNumber: '', streetPrice: '', srpPrice: '',
  introDate: '', manufacturingStatus: '', discontinuedDate: '', estimatedEndOfSupport: '', speedPpm: '', speedRaw: '',
  firstCopyOutSec: '', scanSpeedSimplexBlack: '', scanSpeedSimplexColor: '', scanSpeedDuplexBlack: '', scanSpeedDuplexColor: '',
  documentFeeder: '', scannerFeederType: '', faxCapable: '', hasEthernet: '', hasWifi: '', hasNfc: '', networkInterfaceRaw: '',
  maxPaperSize: '', paperSizeClass: '', confidence: '', rawSpec: '', attributes: {},
})

export const CANON_FIELDS: { key: Exclude<keyof Canonical, 'id' | 'spec'>; label: string }[] = [
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

// One toner/supply record; shared by the toner import and BLI capture.
export interface SupplyRec {
  sku: string
  color: string
  cost: number | null
  yieldPages: number | null
  type: string
  raw: string
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
  capturedSupplies: Record<string, SupplyRec[]> // model id → supplies from a BLI capture
}

export const emptyState = (): State => ({ sources: {}, canonicals: [], links: {}, log: [], deleted: [], nextId: 1, redirects: {}, master: '', capturedSupplies: {} })
export const linkKey = (source: string, raw: string) => `${source}\u0001${raw}`
