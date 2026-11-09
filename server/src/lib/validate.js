import { z } from 'zod';
import { badRequest } from './errors.js';
import { MAX_AMOUNT } from './money.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = {};
    for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    const first = Object.entries(fields)[0];
    throw badRequest(first ? `${first[0]}: ${first[1]}` : 'Invalid input', { fields });
  }
  return r.data;
}

export const id = z.coerce.number().int().positive();
export const kobo = z.number({ invalid_type_error: 'must be a number' }).int('must be whole kobo').positive('must be more than zero').max(MAX_AMOUNT, 'is too large');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
export const text = (max = 200) => z.string().trim().min(1, 'is required').max(max);
export const email = z.string().trim().toLowerCase().email('must be a valid email').max(200);

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function paging({ page, pageSize }) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
