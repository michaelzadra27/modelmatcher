// Main entry point for the device spec parser.
// Pure function: (rawText) -> ParseResult. No HTTP, no DB, no I/O.

import {
  isJunkLine,
  isSentinel,
  matchSection,
  splitManufacturer,
  classFromToken,
  normalizeKey,
  snakeKey,
} from './dictionary';
import {
  parsePriceePair,
  parseFirstCopyOut,
  maxPpm,
  classifyPaperClass,
  parseScanSpeed,
  deriveFeederType,
  parseStatus,
  addYears,
  SUPPORT_HORIZON_YEARS,
  parseCapability,
} from './values';
import { parseSupplies } from './supplies';
import { emptyDevice, type ParseResult, type ParsedDevice } from './types';

interface Pair {
  key: string | null; // null => orphan line (no colon)
  value: string;
}

// Split one physical line into key/value pairs, handling:
//  - "Key:\tValue"
//  - "Key1:\tVal1\tKey2:\tVal2"  (two-column rows)
//  - "Key: Value"                (space delimiter)
//  - orphan lines with no colon  (notes)
function extractPairs(line: string): Pair[] {
  const cells = line.split('\t');
  const pairs: Pair[] = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i].trim();
    if (cell === '') {
      i++;
      continue;
    }
    if (cell.endsWith(':')) {
      const key = cell.slice(0, -1).trim();
      const value = i + 1 < cells.length ? cells[i + 1].trim() : '';
      pairs.push({ key, value });
      i += 2;
    } else if (cell.includes(':')) {
      const idx = cell.indexOf(':');
      pairs.push({ key: cell.slice(0, idx).trim(), value: cell.slice(idx + 1).trim() });
      i += 1;
    } else {
      pairs.push({ key: null, value: cell });
      i += 1;
    }
  }
  return pairs;
}

function setAttribute(
  attributes: Record<string, Record<string, string>>,
  section: string,
  key: string,
  value: string,
): void {
  if (isSentinel(value)) return;
  if (!attributes[section]) attributes[section] = {};
  attributes[section][snakeKey(key)] = value.trim();
}

export function parseDevice(rawText: string): ParseResult {
  const device = emptyDevice();
  const attributes: Record<string, Record<string, string>> = {};

  const allLines = rawText.split(/\r?\n/);
  const lines = allLines.filter((l) => !isJunkLine(l));

  // ── Header: first non-junk line is the full device name. ──────────────────
  let cursor = 0;
  if (lines.length > 0) {
    device.fullName = lines[0].trim();
    const { manufacturer, model } = splitManufacturer(device.fullName);
    device.manufacturer = manufacturer;
    device.model = model;
    cursor = 1;
  }

  // Header descriptor lines (until first section or first "key: value").
  // e.g. "MFP • 28 ppm", "Full-color printer, MF", "Laser".
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (matchSection(line)) break;
    if (line.includes(':') && !line.includes('•')) break;

    const lower = line.toLowerCase();
    if (line.includes('•')) {
      // "MFP • 28 ppm" => class + speed
      const [classTok, speedTok] = line.split('•').map((s) => s.trim());
      if (classTok && device.deviceClass === 'unknown') device.deviceClass = classFromToken(classTok);
      if (speedTok && device.speedRaw === null) {
        device.speedRaw = speedTok;
        device.speedPpm = maxPpm(speedTok);
      }
    }
    if (/\bfull-?color\b|\bcolou?r\b/.test(lower) && device.colorCapability === null) {
      device.colorCapability = 'color';
    } else if (/\b(mono|black\s*&?\s*white|b\/w)\b/.test(lower) && device.colorCapability === null) {
      device.colorCapability = 'mono';
    }
    if (/\blaser\b/.test(lower) && device.technology === null) device.technology = 'laser';
    else if (/\bink-?jet\b/.test(lower) && device.technology === null) device.technology = 'inkjet';
    else if (/\bled\b/.test(lower) && device.technology === null) device.technology = 'led';
    if (device.deviceClass === 'unknown') {
      const c = classFromToken(line);
      if (c !== 'unknown') device.deviceClass = c;
    }
    cursor++;
  }

  // Color/mono is often only stated on the mashed header line that gets stripped
  // as junk, e.g. "ColorLetter/Legal/A4Compatible Solutions" or
  // "MonochromeLetter/Legal/A4Compatible Solutions".
  // The same line also encodes the media class, e.g. "ColorLedger/Tabloid/A3…"
  // (A3) vs "ColorLetter/Legal/A4…" (A4). It begins with the color word and the
  // paper tokens; the trailing "Compatible Solutions" is not always present.
  {
    const mashed = allLines
      .slice(0, 8)
      .find((l) => /^(monochrome|colou?r)/i.test(l.trim()) && /letter|legal|ledger|tabloid|a3|a4/i.test(l));
    if (mashed) {
      if (device.colorCapability === null) {
        if (/^\s*mono/i.test(mashed)) device.colorCapability = 'mono';
        else if (/^\s*colou?r/i.test(mashed)) device.colorCapability = 'color';
      }
      if (device.paperSizeClass === null) device.paperSizeClass = classifyPaperClass(mashed);
    }
  }

  // ── Body: walk remaining lines, tracking the current section. ─────────────
  let section = 'overview';
  const supplyLines: string[] = [];

  for (let li = cursor; li < lines.length; li++) {
    const line = lines[li];

    const sec = matchSection(line);
    if (sec) {
      section = sec;
      continue;
    }

    if (section === 'supplies') {
      supplyLines.push(line);
      continue;
    }
    if (section === 'options') {
      continue; // options dropped per product owner
    }

    const pairs = extractPairs(line);
    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi];
      if (pair.key === null) {
        // Orphan note line — attach to the section.
        if (!isSentinel(pair.value)) {
          const existing = attributes[section]?._notes;
          setAttribute(attributes, section, '_notes', existing ? `${existing}; ${pair.value}` : pair.value);
        }
        continue;
      }

      let value = pair.value;
      // Empty value + last pair on the line => value continues on next line.
      if (value === '' && pi === pairs.length - 1) {
        const next = lines[li + 1];
        if (next && !matchSection(next) && !next.includes(':') && next.trim() !== '') {
          value = next.trim();
          li++;
        }
      }
      mapPair(device, attributes, section, pair.key, value);
    }
  }

  // Fallback paper-class from the max paper size if the header didn't state it.
  if (device.paperSizeClass === null && device.maxPaperSize) {
    device.paperSizeClass = classifyPaperClass(device.maxPaperSize);
  }

  // Skip supplies for A3 devices — we never do MPS takeover on A3.
  const supplies = device.paperSizeClass === 'A3' ? [] : parseSupplies(supplyLines);

  // Single-function printers don't fax/scan/copy — record fax as absent rather
  // than leaving it blank when no multifunction section was present.
  if (device.deviceClass === 'printer' && device.faxCapable === null) {
    device.faxCapable = false;
  }

  // Feeder type needs both the Document Feeder field and the scan speeds,
  // which appear in different sections — derive once everything is parsed.
  device.scannerFeederType = deriveFeederType(device.documentFeeder, {
    simplexColor: device.scanSpeedSimplexColor,
    simplexBlack: device.scanSpeedSimplexBlack,
    duplexColor: device.scanSpeedDuplexColor,
    duplexBlack: device.scanSpeedDuplexBlack,
  });

  const unmappedKeys = Object.entries(attributes).flatMap(([sec, kv]) =>
    Object.keys(kv).map((k) => `${sec}.${k}`),
  );

  return {
    device,
    supplies,
    attributes,
    confidence: computeConfidence(device, supplies.length),
    unmappedKeys,
    rawText,
  };
}

// Route a single key/value pair to a first-class column, else to attributes.
function mapPair(
  device: ParsedDevice,
  attributes: Record<string, Record<string, string>>,
  section: string,
  rawKey: string,
  value: string,
): void {
  const key = normalizeKey(rawKey);
  // Labels vary by template with a trailing qualifier, e.g.
  // "First-Page-Out Time (Mono/Color)" or "Paper Size (WxL)". Match on the base.
  const keyBase = key.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // Section-scoped capability flags first (keys like "fax" are ambiguous globally).
  if (section === 'modes') {
    if (key === 'fax') {
      device.faxRaw = value;
      device.faxCapable = parseCapability(value);
      return;
    }
  }

  switch (keyBase) {
    case 'part number':
      if (!isSentinel(value)) device.partNumber = value.trim();
      return;
    case 'srp/street price':
    case 'srp / street price':
    case 'street price': {
      const { srp, street } = parsePriceePair(value);
      device.srpPrice = srp;
      device.streetPrice = street;
      return;
    }
    case 'domestic intro date':
    case 'intro date':
      if (!isSentinel(value)) device.introDate = value.trim();
      return;
    case 'manufacturing status': {
      const { status, raw, date } = parseStatus(value);
      device.manufacturingStatus = status;
      device.manufacturingStatusRaw = raw;
      device.discontinuedDate = date;
      device.estimatedEndOfSupport = date ? addYears(date, SUPPORT_HORIZON_YEARS) : null;
      return;
    }
    case 'speed':
      if (!isSentinel(value)) {
        device.speedRaw = value.trim();
        const ppm = maxPpm(value);
        if (ppm !== null) device.speedPpm = ppm;
      }
      return;
    case 'first-page-out time':
    case 'first copy time':
      if (!isSentinel(value)) {
        device.firstCopyOutRaw = value.trim();
        device.firstCopyOutSec = parseFirstCopyOut(value);
      }
      return;
    case 'scan speed':
      if (!isSentinel(value)) {
        device.scanSpeedRaw = value.trim();
        const ss = parseScanSpeed(value);
        device.scanSpeedSimplexColor = ss.simplexColor;
        device.scanSpeedSimplexBlack = ss.simplexBlack;
        device.scanSpeedDuplexColor = ss.duplexColor;
        device.scanSpeedDuplexBlack = ss.duplexBlack;
      }
      return;
    case 'document feeder':
      if (!isSentinel(value)) device.documentFeeder = value.trim();
      return;
    case 'color type':
      // "Not applicable" on a print device means monochrome; a named type = color.
      if (device.colorCapability === null) {
        device.colorCapability = isSentinel(value) ? 'mono' : 'color';
      }
      return;
    case 'network interface':
    case 'interface type':
    case 'std interface':
    case 'standard interface':
      if (!isSentinel(value)) {
        device.networkInterfaceRaw = device.networkInterfaceRaw
          ? `${device.networkInterfaceRaw}; ${value.trim()}`
          : value.trim();
        if (/ethernet|baset|10\/100|gigabit/i.test(value)) device.hasEthernet = true;
        if (/wireless|wi-?fi|802\.11/i.test(value)) device.hasWifi = true;
      }
      return;
    case 'near field communication':
      device.hasNfc = parseCapability(value);
      return;
    case 'max original size':
    case 'paper sizes':
    case 'paper size':
      if (!isSentinel(value) && device.maxPaperSize === null) device.maxPaperSize = value.trim();
      return;
    default:
      break;
  }

  // Detect WiFi mentioned anywhere in connectivity values.
  if (section === 'connectivity' && /wireless|wi-?fi|802\.11/i.test(value) && device.hasWifi === null) {
    device.hasWifi = true;
  }

  setAttribute(attributes, section, rawKey, value);
}

// Completeness heuristic. Header identity is weighted heavily because a failed
// header parse means we mis-read the whole document.
function computeConfidence(device: ParsedDevice, supplyCount: number): number {
  let score = 0;
  let max = 0;

  const weigh = (got: boolean, weight: number) => {
    max += weight;
    if (got) score += weight;
  };

  weigh(device.manufacturer !== null, 3);
  weigh(device.model !== null && device.model !== '', 2);
  weigh(device.deviceClass !== 'unknown', 2);
  weigh(device.speedRaw !== null, 1);
  weigh(device.partNumber !== null, 1);
  weigh(device.colorCapability !== null, 1);
  weigh(device.streetPrice !== null || device.srpPrice !== null, 1);
  weigh(supplyCount > 0, 2);

  return Math.round((score / max) * 100) / 100;
}

export * from './types';
