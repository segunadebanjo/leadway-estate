import { config } from '../config.js';

// Calendar dates in the estate's timezone (Africa/Lagos, UTC+1, no DST).

/** { year, month (1-12), day } for `date` in the estate's timezone. */
export function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function isoDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function todayIso(date = new Date()) {
  return isoDate(localParts(date));
}

/** A Date at UTC midnight for a YYYY-MM-DD string (how @db.Date columns are stored). */
export function dateOnly(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Bad date ${iso}`);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Bad date ${iso}`);
  return d;
}

export function addDays(iso, days) {
  const d = dateOnly(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function toIso(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

export function daysBetween(fromIso, toIsoStr) {
  return Math.round((dateOnly(toIsoStr) - dateOnly(fromIso)) / 86_400_000);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[m - 1];
