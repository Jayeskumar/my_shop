import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { type TestTenant, closeTestDb, insertTestTenant, testDb } from '../test/helpers'
import { systemContext } from './context'
import { FileService, LocalFileStorage, contentMatchesType, sanitizeFilename } from './files'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('file storage (local disk)', () => {
  let dir: string
  let files: FileService
  let shop: TestTenant

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kadai-files-'))
    files = new FileService(new LocalFileStorage(dir))
    shop = await insertTestTenant(testDb().systemDb)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await closeTestDb()
  })

  const ctx = () => ({ ...systemContext(shop.tenant.id), userId: shop.owner.user_id })

  it('saves under <tenant>/<file> with metadata and reads it back', async () => {
    const row = await withTenant(testDb().appDb, ctx(), (tx) =>
      files.saveFile(tx, ctx(), {
        purpose: 'logo',
        filename: '../../etc/logo.png',
        content_type: 'image/png',
        data: PNG,
      }),
    )
    expect(row).toMatchObject({
      purpose: 'logo',
      filename: 'logo.png',
      content_type: 'image/png',
      size_bytes: PNG.length,
      storage: 'local',
    })
    expect(row.storage_key).toBe(`${shop.tenant.id}/${row.id}`)
    expect(row.checksum_sha256).toMatch(/^[0-9a-f]{64}$/)
    const back = await withTenant(testDb().appDb, ctx(), (tx) =>
      files.getFileRow(tx, ctx(), row.id),
    )
    expect((await files.readContent(back)).equals(PNG)).toBe(true)
  })

  it('enforces type, size and content rules per purpose', async () => {
    const save = (purpose: 'logo' | 'import', content_type: string, data: Buffer) =>
      withTenant(testDb().appDb, ctx(), (tx) =>
        files.saveFile(tx, ctx(), { purpose, filename: 'f', content_type, data }),
      )
    await expect(save('logo', 'image/svg+xml', Buffer.from('<svg/>'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(save('logo', 'image/png', Buffer.from('not a png'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(
      save('logo', 'image/png', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      save('import', 'text/csv', Buffer.from('name,price\nArisi,6500\n')),
    ).resolves.toMatchObject({ purpose: 'import' })
  })

  it('deletes the stored object when the transaction rolls back', async () => {
    let key = ''
    await expect(
      withTenant(testDb().appDb, ctx(), async (tx) => {
        const row = await files.saveFile(tx, ctx(), {
          purpose: 'attachment',
          filename: 'bill.png',
          content_type: 'image/png',
          data: PNG,
        })
        key = row.storage_key
        await expect(stat(path.join(dir, key))).resolves.toBeTruthy()
        throw new Error('business rule failed')
      }),
    ).rejects.toThrow('business rule failed')
    await expect(stat(path.join(dir, key))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses storage keys that escape the base directory', async () => {
    const storage = new LocalFileStorage(dir)
    await expect(storage.put('../outside/x', PNG)).rejects.toThrow(/invalid storage key/)
  })

  it('helpers', () => {
    expect(contentMatchesType(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true)
    expect(contentMatchesType(Buffer.from('<html>'), 'application/pdf')).toBe(false)
    expect(sanitizeFilename('C:\\Users\\shop\\இன்வாய்ஸ்<1>.pdf')).toBe('இன்வாய்ஸ்_1_.pdf')
  })
})
