// Bridges the pure BLI parser to ModelMaster: parse text → DeviceSpec + candidate MM- match.

import { Bucket, reconcile } from '../match'
import { DeviceSpec, State, emptySpec } from '../types'
import { Toner } from '../toner'
import { ParseResult, ParsedSupply } from './types'
import { parseDevice } from './index'

const s = (v: unknown) => (v == null ? '' : String(v))
const bool = (v: boolean | null) => (v == null ? '' : v ? 'yes' : 'no')

/** ParsedDevice → DeviceSpec (all strings for editing). */
export function specFromParsed(r: ParseResult): DeviceSpec {
  const d = r.device
  return {
    ...emptySpec(),
    fullName: s(d.fullName),
    deviceClass: s(d.deviceClass),
    colorCapability: s(d.colorCapability),
    technology: s(d.technology),
    partNumber: s(d.partNumber),
    streetPrice: s(d.streetPrice),
    srpPrice: s(d.srpPrice),
    introDate: s(d.introDate),
    manufacturingStatus: s(d.manufacturingStatus),
    discontinuedDate: s(d.discontinuedDate),
    estimatedEndOfSupport: s(d.estimatedEndOfSupport),
    speedPpm: s(d.speedPpm),
    speedRaw: s(d.speedRaw),
    firstCopyOutSec: s(d.firstCopyOutSec),
    scanSpeedSimplexBlack: s(d.scanSpeedSimplexBlack),
    scanSpeedSimplexColor: s(d.scanSpeedSimplexColor),
    scanSpeedDuplexBlack: s(d.scanSpeedDuplexBlack),
    scanSpeedDuplexColor: s(d.scanSpeedDuplexColor),
    documentFeeder: s(d.documentFeeder),
    scannerFeederType: s(d.scannerFeederType),
    faxCapable: bool(d.faxCapable),
    hasEthernet: bool(d.hasEthernet),
    hasWifi: bool(d.hasWifi),
    hasNfc: bool(d.hasNfc),
    networkInterfaceRaw: s(d.networkInterfaceRaw),
    maxPaperSize: s(d.maxPaperSize),
    paperSizeClass: s(d.paperSizeClass),
    confidence: s(r.confidence),
    rawSpec: r.rawText,
    attributes: r.attributes,
  }
}

/** BLI supplies → the shared Toner shape, so capture reuses the toner/supply pipeline. */
export function suppliesFromParsed(r: ParseResult): Toner[] {
  return r.supplies.map((p: ParsedSupply) => ({
    sku: p.partNumber || p.description,
    color: p.color || '',
    cost: p.price,
    yieldPages: p.yieldPages,
    type: p.supplyType || 'supply',
    raw: p.rawLine,
  }))
}

export interface CaptureResult {
  result: ParseResult
  spec: DeviceSpec
  supplies: Toner[]
  name: string // best device name for matching
  candidateId: string | null // best existing MM- match
  bucket: Bucket
}

/**
 * Parse a pasted BLI spec and find the canonical model it belongs to, reusing the
 * same matcher the Reconcile screen uses (name → MM- key).
 */
export function captureSpec(text: string, state: State): CaptureResult {
  const result = parseDevice(text)
  const d = result.device
  const name = [d.manufacturer, d.model].filter(Boolean).join(' ') || d.fullName || ''
  // Reconcile just this one name against the existing canonicals (same matcher as the Reconcile tab).
  const probe: State = {
    ...state,
    master: '',
    links: {},
    sources: {
      __capture__: { name: '__capture__', columns: ['desc'], roles: { desc: 'description' }, rows: [{ raw: name, count: 1, attrs: { desc: d.fullName || '' } }] },
    },
  }
  const [row] = reconcile(probe)
  
  return {
    result,
    spec: specFromParsed(result),
    supplies: suppliesFromParsed(result),
    name,
    candidateId: row?.resolvedId ?? row?.candidates[0]?.id ?? null,
    bucket: row?.bucket ?? 'none',
  }
}
