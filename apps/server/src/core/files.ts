/**
 * File storage (ARCHITECTURE.md §2, §8.5): uploaded logos, product images, prescriptions,
 * imports/exports and attachments.
 *
 * * Backends: local disk (`KADAI_DATA_DIR/files/<tenant_id>/<file_id>`, on-prem and small
 *   installs) or S3-compatible object storage (cloud, when S3_BUCKET is set). Objects are keyed
 *   `<tenant_id>/<file_id>` in both.
 * * saveFile validates the purpose's type/size allow-list, checks the content's magic bytes
 *   against the declared type (images/PDF), computes sha256, writes the object, then inserts the
 *   `files` row in the caller's transaction; if that transaction rolls back the object is
 *   deleted again.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { type FilePurpose, newId } from '@kadai/shared'
import type { Config, S3Config } from '../config'
import type { Selectable } from 'kysely'
import type { Files } from '../db/schema.generated'
import { type Tx, afterRollback } from '../db/tenant'
import type { RequestContext } from './context'
import { sha256Hex } from './crypto'
import { AppError, notFound, validationError } from './errors'

export type FileRow = Selectable<Files>

export interface FileStorage {
  readonly kind: 'local' | 's3'
  put(key: string, data: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  stream(key: string): Promise<Readable>
  delete(key: string): Promise<void>
}

function assertKey(key: string): void {
  // <tenant uuid>/<file uuid> (plus optional sub-folders for backups/exports): no traversal.
  if (!/^[0-9a-z][0-9a-z_-]*(\/[0-9a-z][0-9a-z._-]*)+$/i.test(key) || key.includes('..')) {
    throw new Error(`invalid storage key "${key}"`)
  }
}

export class LocalFileStorage implements FileStorage {
  readonly kind = 'local' as const
  constructor(private readonly baseDir: string) {}

  private pathOf(key: string): string {
    assertKey(key)
    const full = path.resolve(this.baseDir, key)
    if (!full.startsWith(path.resolve(this.baseDir) + path.sep))
      throw new Error('storage key escapes base dir')
    return full
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.pathOf(key)
    await mkdir(path.dirname(full), { recursive: true })
    // Write-then-rename so readers never see a partial file.
    const tmp = `${full}.${process.pid}.${newId()}.tmp`
    await writeFile(tmp, data, { mode: 0o640 })
    await rename(tmp, full)
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathOf(key))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('file content')
      throw err
    }
  }

  async stream(key: string): Promise<Readable> {
    const full = this.pathOf(key)
    try {
      await stat(full)
    } catch {
      throw notFound('file content')
    }
    return createReadStream(full)
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true })
  }
}

export class S3FileStorage implements FileStorage {
  readonly kind = 's3' as const
  private readonly client: S3Client

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint ?? undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    })
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertKey(key)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    )
  }

  private async body(key: string) {
    assertKey(key)
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      )
      if (!res.Body) throw notFound('file content')
      return res.Body
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') throw notFound('file content')
      throw err
    }
  }

  async get(key: string): Promise<Buffer> {
    const body = await this.body(key)
    return Buffer.from(await body.transformToByteArray())
  }

  async stream(key: string): Promise<Readable> {
    // In Node the SDK returns an IncomingMessage (a Readable) with stream mixins.
    return (await this.body(key)) as unknown as Readable
  }

  async delete(key: string): Promise<void> {
    assertKey(key)
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
  }
}

export function createFileStorage(config: Pick<Config, 's3' | 'dataDir'>): FileStorage {
  return config.s3
    ? new S3FileStorage(config.s3)
    : new LocalFileStorage(path.join(config.dataDir, 'files'))
}

// ---------------------------------------------------------------------------------------------
// Upload rules
// ---------------------------------------------------------------------------------------------

const MB = 1024 * 1024
const IMAGES = ['image/png', 'image/jpeg', 'image/webp'] as const
const SHEETS = [
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export interface FileRule {
  maxBytes: number
  contentTypes: readonly string[]
}

/** Allowed types and maximum size per purpose. SVG is never accepted (script injection). */
export const FILE_RULES: Readonly<Record<FilePurpose, FileRule>> = {
  logo: { maxBytes: 2 * MB, contentTypes: IMAGES },
  product_image: { maxBytes: 5 * MB, contentTypes: IMAGES },
  prescription: { maxBytes: 10 * MB, contentTypes: [...IMAGES, 'application/pdf'] },
  import: { maxBytes: 20 * MB, contentTypes: SHEETS },
  export: {
    maxBytes: 200 * MB,
    contentTypes: [...SHEETS, 'application/json', 'application/pdf', 'application/zip'],
  },
  attachment: { maxBytes: 10 * MB, contentTypes: [...IMAGES, 'application/pdf'] },
}

/** Largest upload any purpose allows (multipart limit). */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(FILE_RULES).map((r) => r.maxBytes))

/** Magic-byte check for binary types we can recognise; text types pass. */
export function contentMatchesType(data: Buffer, contentType: string): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b)
  switch (contentType) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff)
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString('latin1') === 'WEBP'
    case 'application/pdf':
      return data.subarray(0, 5).toString('latin1') === '%PDF-'
    case 'application/zip':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return starts(0x50, 0x4b, 0x03, 0x04)
    default:
      return true
  }
}

/** Keeps a display-safe file name: no path, no control characters, max 200 chars. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim()
  return (clean || 'file').slice(-200)
}

export interface SaveFileInput {
  purpose: FilePurpose
  filename: string
  content_type: string
  data: Buffer
}

export class FileService {
  constructor(readonly storage: FileStorage) {}

  /** Validates, stores and records a file; returns the `files` row. */
  async saveFile(
    tx: Tx,
    ctx: Pick<RequestContext, 'tenantId' | 'userId'>,
    input: SaveFileInput,
  ): Promise<FileRow> {
    const rule = FILE_RULES[input.purpose]
    const contentType = input.content_type.split(';')[0]!.trim().toLowerCase()
    if (!rule.contentTypes.includes(contentType)) {
      throw validationError([
        {
          path: 'file',
          message: `File type ${contentType} is not allowed for ${input.purpose}`,
          code: 'file_type',
        },
      ])
    }
    if (input.data.length === 0)
      throw validationError([{ path: 'file', message: 'File is empty', code: 'file_empty' }])
    if (input.data.length > rule.maxBytes) {
      throw validationError([
        {
          path: 'file',
          message: `File is larger than ${Math.round(rule.maxBytes / MB)} MB`,
          code: 'file_too_large',
        },
      ])
    }
    if (!contentMatchesType(input.data, contentType)) {
      throw validationError([
        { path: 'file', message: 'File content does not match its type', code: 'file_content' },
      ])
    }
    const id = newId()
    const key = `${ctx.tenantId}/${id}`
    await this.storage.put(key, input.data, contentType)
    afterRollback(tx, () => this.storage.delete(key))
    return tx
      .insertInto('files')
      .values({
        id,
        tenant_id: ctx.tenantId,
        purpose: input.purpose,
        filename: sanitizeFilename(input.filename),
        content_type: contentType,
        size_bytes: input.data.length,
        checksum_sha256: sha256Hex(input.data),
        storage: this.storage.kind,
        storage_key: key,
        created_by: ctx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async getFileRow(
    tx: Tx,
    ctx: Pick<RequestContext, 'tenantId'>,
    fileId: string,
  ): Promise<FileRow> {
    const row = await tx
      .selectFrom('files')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', fileId)
      .executeTakeFirst()
    if (!row) throw notFound('file', fileId)
    return row
  }

  /** Reads the content of a file row (the row must come from a tenant-scoped query). */
  async readContent(row: FileRow): Promise<Buffer> {
    this.assertBackend(row)
    return this.storage.get(row.storage_key)
  }

  async openContent(row: FileRow): Promise<Readable> {
    this.assertBackend(row)
    return this.storage.stream(row.storage_key)
  }

  private assertBackend(row: FileRow): void {
    if (row.storage !== this.storage.kind) {
      throw new AppError(
        'INTERNAL',
        `File ${row.id} is stored in ${row.storage}, but this server uses ${this.storage.kind}`,
      )
    }
  }
}
