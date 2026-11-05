// Lookup tables that drive the parser. Extend these (not the parser logic)
// to support new manufacturers, sections, or field promotions.

import type { DeviceClass } from './types';

// ── Junk / UI chrome to strip before parsing ────────────────────────────────
// Copy-pasting the whole spec page drags in navigation and toolbar text.
export const JUNK_PATTERNS: RegExp[] = [
  /^\s*select\s+alerts\s+favorites\s*$/i,
  /specification guide/i,
  /report an error/i,
  /my spec view/i,
  /columnar format/i,
  /export (xls|to word|to pdf)/i,
  /add to folder/i,
  /compatible solutions/i,
  /^\s*english\s*$/i,
  /^\s*print\s*$/i,
  /^\s*\|+\s*$/,
];

export function isJunkLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  return JUNK_PATTERNS.some((re) => re.test(t));
}

// ── Null sentinels — "no data" values that should not be stored ──────────────
const SENTINELS = [
  'ina',
  'na',
  'n/a',
  'not applicable',
  'info not avail',
  'information not available',
  'not avail',
  'none',
  '',
];

export function isSentinel(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/\.+$/, '');
  if (v === '') return true;
  return SENTINELS.some((s) => v === s || v.startsWith('info not avail') || v.startsWith('not avail'));
}

// ── Section headers → canonical section keys ─────────────────────────────────
export const SECTION_HEADERS: Record<string, string> = {
  'multifunction modes': 'modes',
  'general specs/paper handling': 'paper_handling',
  'general specifications': 'general',
  'paper handling': 'paper_handling',
  resolution: 'resolution',
  features: 'features',
  'security specs': 'security',
  'copier features': 'copier_features',
  'other features': 'other_features',
  'additional information': 'additional',
  comments: 'comments',
  'connectivity specs': 'connectivity',
  'interface/connectivity': 'connectivity',
  'printer specs': 'printer',
  'scanner and image management specs': 'scanner',
  'facsimile specs': 'fax',
  'supplies/maintenance': 'supplies',
  supplies: 'supplies',
  options: 'options',
};

export function matchSection(line: string): string | null {
  const key = line.trim().toLowerCase().replace(/\s+/g, ' ');
  return SECTION_HEADERS[key] ?? null;
}

// ── Known manufacturers (canonical names + aliases) ──────────────────────────
// Used to split "HP Color LaserJet Pro MFP M479fdn" into brand + model.
export const MANUFACTURERS: { canonical: string; aliases: string[] }[] = [
  { canonical: 'HP', aliases: ['hp', 'hewlett-packard', 'hewlett packard'] },
  { canonical: 'Brother', aliases: ['brother'] },
  { canonical: 'Canon', aliases: ['canon'] },
  { canonical: 'Xerox', aliases: ['xerox'] },
  { canonical: 'Ricoh', aliases: ['ricoh'] },
  { canonical: 'Konica Minolta', aliases: ['konica minolta', 'konica', 'minolta'] },
  { canonical: 'Kyocera', aliases: ['kyocera'] },
  { canonical: 'Lexmark', aliases: ['lexmark'] },
  { canonical: 'Epson', aliases: ['epson'] },
  { canonical: 'Sharp', aliases: ['sharp'] },
  { canonical: 'Toshiba', aliases: ['toshiba'] },
  { canonical: 'OKI', aliases: ['oki', 'okidata'] },
  { canonical: 'Dell', aliases: ['dell'] },
  { canonical: 'Samsung', aliases: ['samsung'] },
  { canonical: 'Panasonic', aliases: ['panasonic'] },
  { canonical: 'Pantum', aliases: ['pantum'] },
  { canonical: 'Fujifilm', aliases: ['fujifilm', 'fuji xerox', 'fujifilm business innovation'] },
];

export function splitManufacturer(fullName: string): { manufacturer: string | null; model: string } {
  const lower = fullName.toLowerCase();
  for (const m of MANUFACTURERS) {
    for (const alias of m.aliases) {
      if (lower.startsWith(alias + ' ')) {
        return { manufacturer: m.canonical, model: fullName.slice(alias.length).trim() };
      }
    }
  }
  return { manufacturer: null, model: fullName.trim() };
}

// ── Device-class tokens from the header line (e.g. "MFP • 28 ppm") ───────────
export function classFromToken(token: string): DeviceClass {
  const t = token.trim().toLowerCase();
  if (t.includes('mfp') || t.includes('multifunction') || t.includes('all-in-one')) return 'mfp';
  if (t.includes('production')) return 'production';
  if (t.includes('copier')) return 'copier';
  if (t.includes('scanner')) return 'scanner';
  if (t.includes('fax')) return 'fax';
  if (t.includes('printer')) return 'printer';
  return 'unknown';
}

// ── Canonical key normalization ──────────────────────────────────────────────
export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '');
}

// snake_case a key for JSONB attribute storage.
export function snakeKey(key: string): string {
  return normalizeKey(key)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
