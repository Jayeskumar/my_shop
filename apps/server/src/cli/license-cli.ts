/**
 * Vendor license tool (ARCHITECTURE.md §2, §17): `issue-license keygen | sign | verify`.
 * Available as `pnpm --filter @kadai/server issue-license …` (scripts/issue-license.ts) and as the
 * `cli issue-license …` passthrough.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { newId } from '@kadai/shared'
import { type LicensePayload, LicensePayloadSchema, parsePublicKey, signLicense, trustedLicenseKeys, verifyLicense } from '../core/license'
import type { CliIo } from './types'

const USAGE = `Usage:
  issue-license keygen --out <dir> [--kid <kid>]
  issue-license sign --key <private.pem> --kid <kid> --licensee <name> --business-name <name>
                     --plan <free|growth|pro|enterprise> --max-stores <n> --valid-from <YYYY-MM-DD>
                     (--valid-until <YYYY-MM-DD> | --perpetual) [--installation-id <id>]
                     [--features a,b,c] [--limits '{"users":10}'] [--license-id <id>] [--out <file>]
  issue-license verify --file <license.json> [--public-key <public.pem>] [--installation-id <id>]
                       [--production] [--today <YYYY-MM-DD>]`

export async function runLicenseCli(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'keygen':
      return keygen(rest, io)
    case 'sign':
      return sign(rest, io)
    case 'verify':
      return verifyCmd(rest, io)
    default:
      io.log(USAGE)
      return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 64
  }
}

async function keygen(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, kid: { type: 'string' } } })
  if (!values.out) {
    io.log(USAGE)
    return 64
  }
  const kid = values.kid ?? `key-${new Date().getFullYear()}`
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(kid)) throw new Error('kid must be lower-case letters, digits and dashes')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  await mkdir(values.out, { recursive: true })
  const priv = path.join(values.out, `${kid}.private.pem`)
  const pub = path.join(values.out, `${kid}.public.pem`)
  await writeFile(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await writeFile(pub, pubPem, { flag: 'wx' })
  io.log(`private key: ${priv} (keep secret)\npublic key:  ${pub}`)
  io.out(pubPem.trim())
  return 0
}

async function sign(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      key: { type: 'string' },
      kid: { type: 'string' },
      licensee: { type: 'string' },
      'business-name': { type: 'string' },
      plan: { type: 'string' },
      'max-stores': { type: 'string' },
      'valid-from': { type: 'string' },
      'valid-until': { type: 'string' },
      perpetual: { type: 'boolean', default: false },
      'installation-id': { type: 'string' },
      features: { type: 'string' },
      limits: { type: 'string' },
      'license-id': { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!values.key || !values.kid || !values.licensee || !values.plan || !values['valid-from']) {
    io.log(USAGE)
    return 64
  }
  if (!values.perpetual && !values['valid-until']) throw new Error('give --valid-until or --perpetual')
  const payload: LicensePayload = LicensePayloadSchema.parse({
    license_id: values['license-id'] ?? newId(),
    licensee: values.licensee,
    business_name: values['business-name'] ?? values.licensee,
    plan_code: values.plan,
    max_stores: Number(values['max-stores'] ?? 1),
    valid_from: values['valid-from'],
    valid_until: values.perpetual ? null : values['valid-until'],
    issued_at: new Date().toISOString(),
    ...(values['installation-id'] ? { installation_id: values['installation-id'] } : {}),
    ...(values.features ? { features: values.features.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
    ...(values.limits ? { limits: JSON.parse(values.limits) as unknown } : {}),
  })
  const doc = signLicense(payload, await readFile(values.key, 'utf8'), values.kid)
  const text = `${JSON.stringify(doc, null, 2)}\n`
  if (values.out) {
    await writeFile(values.out, text)
    io.log(`license ${payload.license_id} written to ${values.out}`)
  } else {
    io.out(text.trimEnd())
  }
  return 0
}

async function verifyCmd(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      'public-key': { type: 'string' },
      'installation-id': { type: 'string' },
      production: { type: 'boolean', default: false },
      today: { type: 'string' },
    },
  })
  if (!values.file) {
    io.log(USAGE)
    return 64
  }
  const doc = JSON.parse(await readFile(values.file, 'utf8')) as unknown
  const keys = values['public-key']
    ? [{ kid: null, key: parsePublicKey(await readFile(values['public-key'], 'utf8')), devOnly: false }]
    : trustedLicenseKeys(process.env.KADAI_LICENSE_PUBLIC_KEY || null)
  const result = verifyLicense(doc, {
    keys,
    production: values.production,
    today: values.today,
    installationId: values['installation-id'] ?? null,
  })
  io.out(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}
