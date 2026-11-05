// Pure, dependency-free types for the device spec parser.
// Shared contract for the API, future browser extension, and bulk import.

export type DeviceClass =
  | 'printer'
  | 'mfp'
  | 'copier'
  | 'scanner'
  | 'production'
  | 'fax'
  | 'unknown';

export interface ParsedSupply {
  description: string;
  partNumber: string | null;
  color: string | null; // black | cyan | magenta | yellow | tri-color | color
  yieldPages: number | null;
  price: number | null;
  coverage: string | null;
  supplyType: string | null; // toner | ink | drum | cartridge | maintenance
  rawLine: string;
}

export interface ParsedDevice {
  // Identity
  manufacturer: string | null;
  model: string | null;
  fullName: string | null;
  deviceClass: DeviceClass;
  colorCapability: string | null; // 'color' | 'mono'
  technology: string | null; // 'laser' | 'inkjet' | 'led' | ...

  // SKU / pricing / lifecycle
  partNumber: string | null;
  streetPrice: number | null;
  srpPrice: number | null;
  introDate: string | null;
  manufacturingStatus: string | null; // 'active' | 'discontinued'
  manufacturingStatusRaw: string | null;
  discontinuedDate: string | null; // 'YYYY-MM-01' from "Discontinued (MM/YYYY)"
  estimatedEndOfSupport: string | null; // discontinuedDate + SUPPORT_HORIZON_YEARS

  // Performance
  speedPpm: number | null; // single headline value = max(black, color)
  speedRaw: string | null;
  firstCopyOutSec: number | null;
  firstCopyOutRaw: string | null;
  scanSpeedSimplexBlack: number | null;
  scanSpeedSimplexColor: number | null;
  scanSpeedDuplexBlack: number | null;
  scanSpeedDuplexColor: number | null;
  scanSpeedRaw: string | null;
  documentFeeder: string | null; // raw, e.g. "Std DSPF"
  scannerFeederType: string | null; // derived: 'single-pass' | 'reversing'

  // Capabilities (elevated per product owner)
  faxCapable: boolean | null;
  faxRaw: string | null;
  hasEthernet: boolean | null;
  hasWifi: boolean | null;
  hasNfc: boolean | null;
  networkInterfaceRaw: string | null;

  // Paper
  maxPaperSize: string | null;
  paperSizeClass: string | null; // 'A3' | 'A4'
}

export interface ParseResult {
  device: ParsedDevice;
  supplies: ParsedSupply[];
  // Everything recognized but not promoted to a column, namespaced by section.
  attributes: Record<string, Record<string, string>>;
  confidence: number; // 0..1 completeness heuristic
  unmappedKeys: string[]; // "section.key" entries that landed in attributes
  rawText: string;
}

export function emptyDevice(): ParsedDevice {
  return {
    manufacturer: null,
    model: null,
    fullName: null,
    deviceClass: 'unknown',
    colorCapability: null,
    technology: null,
    partNumber: null,
    streetPrice: null,
    srpPrice: null,
    introDate: null,
    manufacturingStatus: null,
    manufacturingStatusRaw: null,
    discontinuedDate: null,
    estimatedEndOfSupport: null,
    speedPpm: null,
    speedRaw: null,
    firstCopyOutSec: null,
    firstCopyOutRaw: null,
    scanSpeedSimplexBlack: null,
    scanSpeedSimplexColor: null,
    scanSpeedDuplexBlack: null,
    scanSpeedDuplexColor: null,
    scanSpeedRaw: null,
    documentFeeder: null,
    scannerFeederType: null,
    faxCapable: null,
    faxRaw: null,
    hasEthernet: null,
    hasWifi: null,
    hasNfc: null,
    networkInterfaceRaw: null,
    maxPaperSize: null,
    paperSizeClass: null,
  };
}
