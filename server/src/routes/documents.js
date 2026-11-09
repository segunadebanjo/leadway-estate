import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, z, id, text } from '../lib/validate.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

// Document centre: PDF / Word only, checked by content (magic bytes), not by
// the name or the browser's claimed type. Stored in the database (see Document.content).
export const router = Router();

export const DOC_CATEGORIES = ['Constitution & Bye-laws', 'Minutes', 'Financial Reports', 'Circulars', 'Forms', 'Other'];
const MAX_BYTES = 10 * 1024 * 1024;

const TYPES = {
  pdf: { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && b.includes(Buffer.from('word/')),
  },
  doc: { mime: 'application/msword', test: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
};

/** The file's real type from its bytes and extension, or null. */
export function detectDocType(originalName, buffer) {
  const ext = path.extname(originalName || '').slice(1).toLowerCase();
  const t = TYPES[ext];
  return t && buffer?.length && t.test(buffer) ? { ext, mime: t.mime } : null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

router.get('/', requireAuth, async (req, res) => {
  const q = parse(z.object({ category: z.string().max(60).optional(), q: z.string().trim().max(100).optional() }), req.query);
  const rows = await prisma.document.findMany({
    where: {
      ...(q.category ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { originalName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, category: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { firstName: true, lastName: true } } },
  });
  res.json({ rows, categories: DOC_CATEGORIES });
});

router.get('/:id/download', requireAuth, async (req, res) => {
  const docId = parse(id, req.params.id);
  const doc = await prisma.document.findUnique({ where: { id: docId } });
  if (!doc) throw notFound('Document not found');
  let body = doc.content ? Buffer.from(doc.content) : null;
  if (!body) {
    // Documents uploaded before files moved into the database live on disk.
    body = await fs.readFile(path.join(config.uploadDir, doc.fileName)).catch(() => null);
    if (!body) throw notFound('The file is missing from storage');
  }
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.send(body);
});

router.post('/', requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB' : 'Upload failed'));
    next();
  });
}, async (req, res) => {
  const body = parse(z.object({ title: text(150), category: z.enum(DOC_CATEGORIES) }), req.body);
  if (!req.file) throw badRequest('Choose a file to upload');
  const type = detectDocType(req.file.originalname, req.file.buffer);
  if (!type) throw badRequest('Only PDF and Word documents (.pdf, .doc, .docx) are accepted, and the file must really be one');
  const fileName = `${crypto.randomUUID()}.${type.ext}`;
  const doc = await prisma.document.create({
    data: { title: body.title, category: body.category, fileName, originalName: path.basename(req.file.originalname).slice(0, 200), mimeType: type.mime, sizeBytes: req.file.size, content: req.file.buffer, uploadedById: req.user.id },
    select: { id: true, title: true, category: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true },
  });
  await audit(req, 'document.upload', 'Document', doc.id, { title: doc.title, category: doc.category });
  res.status(201).json(doc);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const docId = parse(id, req.params.id);
  const doc = await prisma.document.findUnique({ where: { id: docId }, select: { id: true, title: true, fileName: true } });
  if (!doc) throw notFound('Document not found');
  await prisma.document.delete({ where: { id: docId } });
  await fs.rm(path.join(config.uploadDir, doc.fileName), { force: true });
  await audit(req, 'document.delete', 'Document', docId, { title: doc.title });
  res.json({ ok: true });
});
