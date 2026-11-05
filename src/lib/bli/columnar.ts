// Parses BLI bliQ "columnar" comparison exports (up to 25 devices per file).
// Layout is transposed vs a single spec page: rows are fields (label in col A),
// columns are devices. Each device column is therefore the same label/value
// stream the single-page parser handles, so this reuses the value parsers and
// attribute bucketing. Pure: takes row arrays, returns parsed devices.

import { isSentinel, snakeKey, classFromToken } from './dictionary';
import {
  parseMoney,
  parseStatus,
  addYears,
  SUPPORT_HORIZON_YEARS,
  maxPpm,
  parseFirstCopyOut,
  parseScanSpeed,
  deriveFeederType,
  classifyPaperClass,
  parseCapability,
} from './values';
import { parseSupplies } from './supplies';
import { emptyDevice, type ParsedDevice, type ParsedSupply } from './types';

export type Grid = unknown[][];

export interface ColumnarDevice {
  device: ParsedDevice;
  supplies: ParsedSupply[];
  attributes: Record<string, Record<string, string>>;
  environmental: Record<string, Record<string, string>>;
}

// Known columnar section headers → canonical section keys.
const SECTIONS: Record<string, string> = {
  'background information': 'background',
  'multifunction modes': 'modes',
  'general specifications': 'general',
  'print specifications': 'print',
  'print features': 'features',
  'color capabilities': 'color',
  'paper handling': 'paper_handling',
  'control panel': 'control_panel',
  'interface/connectivity specifications': 'connectivity',
  'finishing capabilities': 'finishing',
  'additional information': 'additional',
  'security specs': 'security',
  'copier specifications': 'copier',
  'copier features': 'copier_features',
  'scanner and image management specifications': 'scanner',
  'facsimile specifications': 'fax',
  'dialing capabilities': 'fax',
  comments: 'comments',
  supplies: 'supplies',
  options: 'options',
};

const cell = (row: unknown[] | undefined, i: number): string =>
  row ? String(row[i] ?? '').trim() : '';

function deviceCount(grid: Grid): number {
  const header = grid[0] ?? [];
  let n = 0;
  for (let i = 1; i < header.length; i++) if (String(header[i] ?? '').trim()) n = i;
  return n; // number of device columns (1..n)
}

// A row is a section header when it is a known section, or an all-caps
// multi-word label whose device cells are all empty.
function sectionKey(label: string, values: string[]): string | null {
  const norm = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (SECTIONS[norm]) return SECTIONS[norm];
  const allEmpty = values.every((v) => v === '');
  if (allEmpty && /\s/.test(label) && label === label.toUpperCase() && /[A-Z]/.test(label)) {
    return snakeKey(label);
  }
  return null;
}

function setAttr(
  attrs: Record<string, Record<string, string>>,
  section: string,
  label: string,
  value: string,
): void {
  if (isSentinel(value)) return;
  (attrs[section] ??= {})[snakeKey(label)] = value;
}

// Map one columnar (section, label, value) to first-class fields, else attrs.
function mapField(
  d: ParsedDevice,
  attrs: Record<string, Record<string, string>>,
  section: string,
  label: string,
  value: string,
): void {
  const key = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const v = value.trim();
  const clean = isSentinel(v) ? '' : v;

  switch (key) {
    case 'manufacturer':
      if (clean) d.manufacturer = clean;
      return;
    case 'model':
      if (clean) d.model = clean;
      return;
    case 'srp':
      d.srpPrice = parseMoney(v);
      return;
    case 'street price':
      d.streetPrice = parseMoney(v);
      return;
    case 'part number':
      if (clean) d.partNumber = clean;
      return;
    case 'manufacturing status': {
      const { status, raw } = parseStatus(v);
      d.manufacturingStatus = status;
      d.manufacturingStatusRaw = raw;
      return;
    }
    case 'discontinued date': {
      // Columnar gives the date directly, e.g. "09/2017".
      const m = v.match(/(\d{1,2})\/(\d{4})/);
      if (m) {
        d.discontinuedDate = `${m[2]}-${m[1].padStart(2, '0')}-01`;
        d.estimatedEndOfSupport = addYears(d.discontinuedDate, SUPPORT_HORIZON_YEARS);
      }
      return;
    }
    case 'domestic intro date':
      if (clean) d.introDate = clean;
      return;
    case 'print speed (letter/a4)':
    case 'print speed':
      if (clean) {
        d.speedRaw = clean;
        d.speedPpm = maxPpm(v);
      }
      return;
    case 'first-page-out time (mono/color)':
    case 'first-page-out time':
    case 'first copy time':
      if (clean) {
        d.firstCopyOutRaw = clean;
        d.firstCopyOutSec = parseFirstCopyOut(v);
      }
      return;
    case 'print technology':
      if (/laser/i.test(v)) d.technology = 'laser';
      else if (/ink-?jet/i.test(v)) d.technology = 'inkjet';
      else if (/led/i.test(v)) d.technology = 'led';
      else if (clean) d.technology = clean.toLowerCase();
      return;
    case 'max color channels':
      if (/\b1-?color\b|mono/i.test(v)) d.colorCapability = 'mono';
      else if (/color/i.test(v)) d.colorCapability = 'color';
      return;
    case 'max sheet size':
    case 'max original size':
      if (clean && d.maxPaperSize === null) {
        d.maxPaperSize = clean;
        d.paperSizeClass = classifyPaperClass(clean);
      }
      return;
    case 'scan speed':
      if (clean) {
        d.scanSpeedRaw = clean;
        const ss = parseScanSpeed(v);
        d.scanSpeedSimplexColor = ss.simplexColor;
        d.scanSpeedSimplexBlack = ss.simplexBlack;
        d.scanSpeedDuplexColor = ss.duplexColor;
        d.scanSpeedDuplexBlack = ss.duplexBlack;
      }
      return;
    case 'document feeder':
      if (clean) d.documentFeeder = clean;
      return;
    case 'std interface':
    case 'opt interface':
    case 'network interface':
    case 'interface type':
      if (clean) {
        d.networkInterfaceRaw = d.networkInterfaceRaw ? `${d.networkInterfaceRaw}; ${clean}` : clean;
        if (/ethernet|baset|10\/100|gigabit/i.test(v)) d.hasEthernet = true;
        if (/wireless|wi-?fi|802\.11/i.test(v)) d.hasWifi = true;
      }
      return;
    case 'near field communication':
      d.hasNfc = parseCapability(v);
      return;
    default:
      break;
  }

  // Fax capability lives under MULTIFUNCTION MODES as a "Fax" row.
  if (section === 'modes' && key === 'fax') {
    d.faxRaw = clean || v;
    d.faxCapable = parseCapability(v);
    return;
  }

  setAttr(attrs, section, label, value);
}

// Derive device class from the multifunction modes / model name.
function deriveClass(d: ParsedDevice, modes: Record<string, string>): void {
  const name = `${d.fullName ?? ''} ${d.model ?? ''}`;
  const c = classFromToken(name);
  if (c !== 'unknown') {
    d.deviceClass = c;
    return;
  }
  const has = (k: string) => /^(std|standard|opt|optional|yes)/i.test(modes[k] ?? '');
  // An empty MODES section is itself the signal of a single-function printer.
  if (has('scanner') || has('copier') || has('fax')) d.deviceClass = 'mfp';
  else d.deviceClass = 'printer';
}

// Collect a device column's non-empty values from an environmental sheet.
function collectEnv(grid: Grid | undefined, col: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!grid) return out;
  for (let r = 0; r < grid.length; r++) {
    const label = cell(grid[r], 0);
    const value = cell(grid[r], col);
    if (label && value) out[snakeKey(label)] = value;
  }
  return out;
}

// Match an environmental sheet's device columns to the specs order by name.
function envColumnFor(grid: Grid | undefined, fullName: string, specIndex: number): number {
  if (!grid) return -1;
  const header = grid[0] ?? [];
  const exact = header.findIndex((h, i) => i > 0 && String(h ?? '').trim() === fullName);
  if (exact > 0) return exact;
  // Fall back to positional (comparison sheets share device order).
  return String(header[specIndex + 1] ?? '').trim() ? specIndex + 1 : -1;
}

export function parseColumnar(specs: Grid, envRatings?: Grid, envSurvey?: Grid): ColumnarDevice[] {
  const nd = deviceCount(specs);
  if (nd < 1) return [];

  const devices = Array.from({ length: nd }, () => emptyDevice());
  const attrs: Record<string, Record<string, string>>[] = Array.from({ length: nd }, () => ({}));
  const modes: Record<string, string>[] = Array.from({ length: nd }, () => ({}));
  const supplyText: string[] = Array.from({ length: nd }, () => '');
  const colorish: boolean[] = Array.from({ length: nd }, () => false);

  for (let d = 0; d < nd; d++) devices[d].fullName = cell(specs[0], d + 1);

  let section = 'overview';
  for (let r = 1; r < specs.length; r++) {
    const row = specs[r];
    const label = cell(row, 0);
    if (!label) continue;
    const values = Array.from({ length: nd }, (_, d) => cell(row, d + 1));

    const sec = sectionKey(label, values);
    if (sec) {
      section = sec;
      continue;
    }
    if (/^©|buyers laboratory/i.test(label)) continue;

    for (let d = 0; d < nd; d++) {
      const value = values[d];
      if (section === 'modes') modes[d][label.toLowerCase().trim()] = value;
      if (section === 'color' && value && !isSentinel(value)) colorish[d] = true;
      if (section === 'supplies') {
        if (value) supplyText[d] += `${value}\n`;
        continue;
      }
      if (section === 'options') continue;
      if (value === '') continue;
      mapField(devices[d], attrs[d], section, label, value);
    }
  }

  return devices.map((device, d) => {
    // Fax rows are captured during the modes pass via mapField already.
    deriveClass(device, modes[d]);
    if (device.deviceClass === 'printer' && device.faxCapable === null) device.faxCapable = false;

    // Color: explicit signal from Max Color Channels wins; else a populated
    // COLOR CAPABILITIES section or "color"/"mono" in the name.
    if (device.colorCapability === null) {
      const name = `${device.fullName ?? ''} ${device.model ?? ''}`.toLowerCase();
      const mfr = (device.manufacturer ?? '').toLowerCase();
      if (colorish[d] || /\bcolor\b/.test(name)) device.colorCapability = 'color';
      else if (/\bmono(chrome)?\b/.test(name)) device.colorCapability = 'mono';
      // Canon iR "C####" and Konica bizhub "C####" denote color models.
      else if (/canon|konica/.test(mfr) && /\bc\d{3,4}/i.test(device.model ?? '')) device.colorCapability = 'color';
      // A laser with no color signal is monochrome (color lasers always say so);
      // inkjets are left null since they're commonly color.
      else if (device.technology === 'laser') device.colorCapability = 'mono';
    }
    if (device.paperSizeClass === null && device.maxPaperSize) {
      device.paperSizeClass = classifyPaperClass(device.maxPaperSize);
    }
    device.scannerFeederType = deriveFeederType(device.documentFeeder, {
      simplexColor: device.scanSpeedSimplexColor,
      simplexBlack: device.scanSpeedSimplexBlack,
      duplexColor: device.scanSpeedDuplexColor,
      duplexBlack: device.scanSpeedDuplexBlack,
    });

    const supplies = supplyText[d].trim() ? parseSupplies(supplyText[d].split('\n')) : [];

    const environmental: Record<string, Record<string, string>> = {};
    const rCol = envColumnFor(envRatings, device.fullName ?? '', d);
    const sCol = envColumnFor(envSurvey, device.fullName ?? '', d);
    const ratings = rCol > 0 ? collectEnv(envRatings, rCol) : {};
    const survey = sCol > 0 ? collectEnv(envSurvey, sCol) : {};
    if (Object.keys(ratings).length) environmental.ratings = ratings;
    if (Object.keys(survey).length) environmental.vendor_survey = survey;

    return { device, supplies, attributes: attrs[d], environmental };
  });
}
