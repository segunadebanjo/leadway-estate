// Reading spreadsheet uploads (Excel .xlsx or .csv) and building their templates.
// Columns are found by their heading, in any order and with common alternative
// names, so a list typed up in Excel by the estate office can be used as it is.
import path from 'node:path';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { badRequest } from './errors.js';

export const MAX_ROWS = 2000;
const MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

/** Express middleware: one spreadsheet in field "file", with friendly errors. */
export function sheetUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB' : 'Upload failed'));
    if (!req.file) return next(badRequest('Choose a file to upload'));
    next();
  });
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** An Excel cell as plain text, a number or a Date (formulas give their result). */
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return '';
  }
  return String(v);
}

/** Minimal CSV reader (quotes, doubled quotes, commas/newlines inside quotes, ; or , separated). */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readGrid(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.csv' || ext === '.txt') return parseCsv(file.buffer.toString('utf8'));
  if (ext === '.xlsx') {
    // A real .xlsx is a zip file: refuse anything else before handing it to the reader.
    if (file.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('That file is not a real Excel (.xlsx) file');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer);
    } catch {
      throw badRequest('The Excel file could not be read. Open it in Excel and save it again as .xlsx');
    }
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
    if (!ws) return [];
    const grid = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => {
      const vals = [];
      r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellValue(c.value); });
      grid[n - 1] = Array.from(vals, (v) => v ?? '');
    });
    return Array.from(grid, (r) => r || []);
  }
  if (ext === '.xls') throw badRequest('Old Excel (.xls) files are not supported. In Excel choose File > Save As > Excel Workbook (.xlsx), then upload that');
  throw badRequest('Upload an Excel (.xlsx) or CSV (.csv) file');
}

const blank = (v) => v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim());

/**
 * Reads the upload and maps its columns onto `fields` ([{ key, label, aliases?, required? }]).
 * The heading row is the first row (within the first 10) that names every required column.
 * Returns { rows: [{ rowNumber, values: { key: value } }], ignored: [headings not used] }.
 */
export async function readSheet(file, fields) {
  const grid = await readGrid(file);
  const names = fields.map((f) => ({ f, names: new Set([f.label, f.key, ...(f.aliases || [])].map(norm)) }));
  let headerAt = -1;
  let map = null;
  for (let i = 0; i < Math.min(grid.length, 10) && headerAt < 0; i++) {
    const m = new Map();
    grid[i].forEach((h, col) => {
      const hit = names.find((n) => n.names.has(norm(h)) && ![...m.values()].includes(n.f.key));
      if (hit) m.set(col, hit.f.key);
    });
    if (fields.filter((f) => f.required).every((f) => [...m.values()].includes(f.key))) { headerAt = i; map = m; }
  }
  if (headerAt < 0) {
    const need = fields.filter((f) => f.required).map((f) => `"${f.label}"`).join(', ');
    throw badRequest(`Could not find the column headings. The first row must name the columns, including ${need}. Download the template to see the layout.`);
  }
  const ignored = grid[headerAt].filter((h, col) => !blank(h) && !map.has(col)).map(String);
  const rows = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.every(blank)) continue;
    const values = {};
    for (const [col, key] of map) values[key] = typeof r[col] === 'string' ? r[col].trim() : r[col] ?? '';
    rows.push({ rowNumber: i + 1, values });
  }
  if (rows.length > MAX_ROWS) throw badRequest(`The file has ${rows.length} rows; upload at most ${MAX_ROWS} at a time`);
  return { rows, ignored };
}

/** Builds an .xlsx template: a heading row, example rows and a Notes sheet. */
export async function templateBuffer({ sheetName, fields, examples = [], notes = [] }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = fields.map((f) => ({ header: f.label + (f.required ? ' *' : ''), key: f.key, width: Math.max(14, f.label.length + 6) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  fields.forEach((f, i) => { if (f.text) ws.getColumn(i + 1).numFmt = '@'; });
  for (const e of examples) ws.addRow(e);
  if (notes.length) {
    const n = wb.addWorksheet('Notes');
    n.getColumn(1).width = 110;
    notes.forEach((t) => n.addRow([t]));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function sendXlsx(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// ---- Cell readers --------------------------------------------------------------

export const isBlank = blank;

/** Text, with Excel numbers shown as written (no "1.0E10"). */
export function asText(v) {
  if (blank(v)) return '';
  if (v instanceof Date) return asDate(v) || '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** A Nigerian phone number; puts back the leading 0 Excel drops from 08031234567. */
export function asPhone(v) {
  let s = asText(v).replace(/\s+/g, ' ');
  if (/^[789]\d{9}$/.test(s)) s = '0' + s;
  if (/^234[789]\d{9}$/.test(s)) s = '+' + s;
  return s;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A date as YYYY-MM-DD, or null if it can't be read. Accepts Excel dates,
 * 2026-03-15, 15/03/2026 (day first, as written in Nigeria) and 15 Mar 2026.
 */
export function asDate(v) {
  if (blank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (v < 1 || v > 80000) return null;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{4})$/i)) && MONTHS[m[2].toLowerCase()]) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** A naira amount ("₦12,500.00", 12500) in kobo, or null if not a positive amount. */
export function asKobo(v) {
  if (blank(v)) return null;
  if (typeof v === 'number') return v > 0 && Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).replace(/[₦,\s]|NGN|N(?=\d)/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const k = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return k > 0 && Number.isSafeInteger(k) ? k : null;
}
