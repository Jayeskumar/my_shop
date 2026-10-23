/**
 * Files (docs/API.md "identity" → files): multipart upload with per-purpose limits
 * (FILE_UPLOAD_RULES: logo / product images ≤ 2 MB PNG/JPEG/WebP, prescriptions ≤ 5 MB images or
 * PDF, imports ≤ 10 MB CSV/XLSX) and per-purpose upload permissions (FILE_UPLOAD_PERMISSIONS);
 * storage and the magic-byte check are core/files (local disk on-prem, S3 in the cloud).
 * Metadata and content are tenant-scoped (RLS + explicit tenant filter): another tenant's file id
 * is simply not found. Content is immutable, so it is cached privately for a year with an ETag.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { hasPermission } from '@kadai/shared'
import {
  FILE_UPLOAD_PERMISSIONS,
  FILE_UPLOAD_RULES,
  type FileMeta,
  type UploadPurpose,
  fileUploadIssue,
} from '@kadai/shared/api/identity'
import { validationError } from '../../core/errors'
import type { FileRow, FileService } from '../../core/files'
import { type Ctx, iso, reasonForbidden } from './common'

export function toFileMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    purpose: row.purpose as FileMeta['purpose'],
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    checksum_sha256: row.checksum_sha256,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    content_path: `/files/${row.id}/content`,
  }
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * The declared content type, or — when the browser sent a generic one (some send
 * application/octet-stream or nothing for .csv / .xlsx) — the type of the file extension.
 */
export function resolveContentType(mimetype: string | undefined, filename: string): string {
  const declared = (mimetype ?? '').split(';')[0]!.trim().toLowerCase()
  if (declared && declared !== 'application/octet-stream') return declared
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_TYPES[ext] ?? (declared || 'application/octet-stream')
}

export function assertUploadPermission(ctx: Ctx, purpose: UploadPurpose): void {
  const needed = FILE_UPLOAD_PERMISSIONS[purpose]
  if (needed.length && !hasPermission(ctx.permissions, needed)) {
    throw reasonForbidden('upload_permission', `You may not upload ${purpose} files`, {
      required: needed,
      purpose,
    })
  }
}

const fileIssue = (code: string, message: string) =>
  validationError([{ path: 'file', message: code, code }], message)

function isFileTooLarge(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'FST_REQ_FILE_TOO_LARGE'
}

/** Reads the single `file` part of a multipart request within the purpose's size limit. */
export async function readUpload(
  req: FastifyRequest,
  purpose: UploadPurpose,
): Promise<{ filename: string; content_type: string; data: Buffer }> {
  const rule = FILE_UPLOAD_RULES[purpose]
  if (!req.isMultipart()) throw fileIssue('file_required', 'Send the file as multipart/form-data')
  let part
  try {
    part = await req.file({ limits: { fileSize: rule.max_bytes, files: 1, fields: 5, parts: 6 } })
  } catch (err) {
    if (isFileTooLarge(err)) throw fileIssue('file_too_large', 'The file is too large')
    throw err
  }
  if (!part) throw fileIssue('file_required', 'No file was sent')
  let data: Buffer
  try {
    data = await part.toBuffer()
  } catch (err) {
    if (isFileTooLarge(err)) {
      throw fileIssue(
        'file_too_large',
        `The file is larger than ${Math.round(rule.max_bytes / (1024 * 1024))} MB`,
      )
    }
    throw err
  }
  const filename = part.filename || 'file'
  const contentType = resolveContentType(part.mimetype, filename)
  const issue = fileUploadIssue(purpose, { size: data.length, type: contentType })
  if (issue) {
    throw fileIssue(
      issue,
      issue === 'file_type'
        ? `Files of type ${contentType} cannot be uploaded as ${purpose}`
        : issue === 'file_empty'
          ? 'The file is empty'
          : 'The file is too large',
    )
  }
  return { filename, content_type: contentType, data }
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(filename: string, download: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Streams a file row's content with type, disposition and private immutable caching. */
export async function sendFileContent(
  files: FileService,
  req: FastifyRequest,
  reply: FastifyReply,
  row: FileRow,
  download: boolean,
): Promise<FastifyReply> {
  const etag = `"${row.checksum_sha256}"`
  reply
    .header('cache-control', 'private, max-age=31536000, immutable')
    .header('etag', etag)
    .header('x-content-type-options', 'nosniff')
  const inm = req.headers['if-none-match']
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return reply.code(304).send()
  }
  const stream = await files.openContent(row)
  return reply
    .code(200)
    .header('content-type', row.content_type)
    .header('content-length', String(row.size_bytes))
    .header('content-disposition', contentDisposition(row.filename, download))
    .send(stream)
}
