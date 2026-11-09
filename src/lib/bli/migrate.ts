// One-time importer for PrinterAPI's exported `devices` table (CSV) → ModelMaster models.
// Each device row already holds parsed BLI fields, so we only map columns → DeviceSpec and
// match the name to an existing MM- key (enrich) or flag it to create a new model.
import * as XLSX from 'xlsx'
import { Bucket, reconcile } from '../match'
import { canonMfr, parse } from '../normalize'
import { DeviceSpec, State, emptySpec } from '../types'

const s = (v: unknown) => (v == null ? '' : String(v).trim())
const yn = (v: unknown) => { const t = s(v).toLowerCase(); return t === 'true' ? 'yes' : t === 'false' ? 'no' : '' }

/** A PrinterAPI devices-CSV row → DeviceSpec (columns are snake_case, matching our model columns). */
export function specFromCsvRow(r: Record<string, unknown>): DeviceSpec {
  let attributes: DeviceSpec['attributes'] = {}
  try {
    const a = s(r.attributes)
    if (a) attributes = JSON.parse(a)
  } catch {
    /* leave empty */
  }
  return {
    ...emptySpec(),
    fullName: s(r.full_name),
    deviceClass: s(r.device_class),
    colorCapability: s(r.color_capability),
    technology: s(r.technology),
    partNumber: s(r.part_number),
    streetPrice: s(r.street_price),
    srpPrice: s(r.srp_price),
    introDate: s(r.intro_date),
    manufacturingStatus: s(r.manufacturing_status),
    discontinuedDate: s(r.discontinued_date),
    estimatedEndOfSupport: s(r.estimated_end_of_support),
    speedPpm: s(r.speed_ppm),
    speedRaw: s(r.speed_raw),
    firstCopyOutSec: s(r.first_copy_out_sec),
    scanSpeedSimplexBlack: s(r.scan_speed_simplex_black),
    scanSpeedSimplexColor: s(r.scan_speed_simplex_color),
    scanSpeedDuplexBlack: s(r.scan_speed_duplex_black),
    scanSpeedDuplexColor: s(r.scan_speed_duplex_color),
    documentFeeder: s(r.document_feeder),
    scannerFeederType: s(r.scanner_feeder_type),
    faxCapable: yn(r.fax_capable),
    hasEthernet: yn(r.has_ethernet),
    hasWifi: yn(r.has_wifi),
    hasNfc: yn(r.has_nfc),
    networkInterfaceRaw: s(r.network_interface_raw),
    maxPaperSize: s(r.max_paper_size),
    paperSizeClass: s(r.paper_size_class),
    confidence: s(r.parse_confidence),
    rawSpec: s(r.raw_text),
    attributes,
  }
}

export interface MigrationItem {
  name: string // full device name (with manufacturer) used for matching + the alias
  manufacturer: string
  model: string
  spec: DeviceSpec
  targetId: string | null // existing MM- key to enrich, or null to create a new model
  bucket: Bucket
  candidates: { id: string; label: string; score: number }[]
}

/** Read a devices CSV into spec-bearing rows. */
export function parseDevicesCsv(buf: ArrayBuffer): Record<string, unknown>[] {
  const wb = XLSX.read(buf, { type: 'array', raw: false })
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
}

/** Match one device name against the existing canonicals (same engine as Reconcile). */
export function matchName(name: string, state: State): Pick<MigrationItem, 'targetId' | 'bucket' | 'candidates'> {
  const probe: State = {
    ...state,
    master: '',
    links: {},
    sources: { __mig__: { name: '__mig__', columns: [], roles: {}, rows: [{ raw: name, count: 1, attrs: {} }] } },
    capturedSupplies: {},
  }
  const [row] = reconcile(probe)
  const targetId = row?.resolvedId ?? (row?.bucket === 'confident' ? row.candidates[0]?.id ?? null : null)
  return { targetId, bucket: row?.bucket ?? 'none', candidates: (row?.candidates ?? []).slice(0, 5).map((c) => ({ id: c.id, label: c.label, score: c.score })) }
}

/** Build the full migration plan: every device matched to a key or flagged as new. */
export function planMigration(rows: Record<string, unknown>[], state: State): MigrationItem[] {
  return rows.map((r) => {
    const spec = specFromCsvRow(r)
    const name = s(r.full_name) || s(r.model)
    const manufacturer = canonMfr(name) // brand detected from the full name
    const model = parse(name, { mfr: manufacturer }).base
    return { name, manufacturer, model, spec, ...matchName(name, state) }
  })
}
