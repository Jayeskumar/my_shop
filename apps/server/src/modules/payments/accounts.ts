/**
 * Payment provider accounts — docs/API.md "payments & UPI" (/payment-providers).
 *
 *  - Secrets (Razorpay key id + secret, webhook secret) are encrypted with core/crypto
 *    (AES-256-GCM, AAD `<tenant>:payment_provider_accounts.<column>:<account id>`) and never
 *    returned: the API answers `key_id_masked`, `has_credentials`, `has_webhook_secret`.
 *  - Store scoping: `store_id` null = every store (needs a member with access to all stores to
 *    change); store-scoped members see their stores' accounts and the all-stores ones.
 *  - One default per store (partial unique index): switching runs under a per-scope advisory
 *    lock in the transaction; the first active account of a scope becomes its default.
 *  - Dynamic providers (razorpay, mock) need plan feature `upi_dynamic`; the shop UPI ID needs
 *    `upi_static`; mock also needs KADAI_ENABLE_MOCK_PAYMENTS.
 *  - Settlement account: a bank account of the chart (asset; subtype bank or under it, or with
 *    bank details).
 *  - Every change is audited (payment provider changes, ARCHITECTURE.md §7.7); secrets never
 *    appear in the audit trail.
 */
import { type PaymentProviderCode, defaultMccFor, isUuid, newId } from '@kadai/shared'
import type { BusinessType } from '@kadai/shared'
import { moneyKindOf } from '@kadai/shared/api/accounting'
import {
  PROVIDER_CAPABILITIES,
  type PaymentProviderAccount,
  type PaymentProviderCreateParsed,
  type PaymentProviderListQuerySchema,
  type PaymentProviderUpdateSchema,
  RAZORPAY_WEBHOOK_EVENTS,
  isDynamicProvider,
  maskKeyId,
  paymentWebhookPath,
} from '@kadai/shared/api/payments'
import { sql } from 'kysely'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import { assertFeature } from '../../core/entitlements'
import { assertNotStale, forbidden, notFound } from '../../core/errors'
import { type PageEnvelope, assertStoreAccess, parsePage } from '../../core/http'
import type { KadaiDeps } from '../../core/runtime'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { type Ctx, loadShop, reasonError, recordOf } from './common'
import type { ProviderAccountRuntime, ProviderConfig, ProviderCredentials } from './providers'

type ListQuery = z.output<typeof PaymentProviderListQuerySchema>
type UpdateBody = z.output<typeof PaymentProviderUpdateSchema>

type Deps = Pick<KadaiDeps, 'config' | 'crypto'>

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const aad = (tenantId: string, column: 'credentials' | 'webhook_secret', accountId: string) =>
  `${tenantId}:payment_provider_accounts.${column}:${accountId}`

export function encryptCredentials(
  deps: Pick<KadaiDeps, 'crypto'>,
  tenantId: string,
  accountId: string,
  creds: ProviderCredentials,
): string {
  return deps.crypto.encryptJson(creds, aad(tenantId, 'credentials', accountId))
}

export function decryptCredentials(
  deps: Pick<KadaiDeps, 'crypto'>,
  tenantId: string,
  accountId: string,
  envelope: string,
): ProviderCredentials {
  const v = recordOf(deps.crypto.decryptJson(envelope, aad(tenantId, 'credentials', accountId)))
  if (typeof v.key_id !== 'string' || typeof v.key_secret !== 'string') {
    throw new Error('payment provider credentials are malformed')
  }
  return { key_id: v.key_id, key_secret: v.key_secret }
}

export function encryptWebhookSecret(
  deps: Pick<KadaiDeps, 'crypto'>,
  tenantId: string,
  accountId: string,
  secret: string,
): string {
  return deps.crypto.encrypt(secret, aad(tenantId, 'webhook_secret', accountId))
}

export function decryptWebhookSecret(
  deps: Pick<KadaiDeps, 'crypto'>,
  tenantId: string,
  accountId: string,
  envelope: string,
): string {
  return deps.crypto.decrypt(envelope, aad(tenantId, 'webhook_secret', accountId))
}

export function readProviderConfig(v: unknown): ProviderConfig {
  const r = recordOf(v)
  const out: ProviderConfig = {}
  if (typeof r.auto_pay_delay_ms === 'number' && Number.isSafeInteger(r.auto_pay_delay_ms)) {
    out.auto_pay_delay_ms = Math.max(0, r.auto_pay_delay_ms)
  }
  if (typeof r.key_id_masked === 'string') out.key_id_masked = r.key_id_masked
  return out
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

function accountQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('payment_provider_accounts as p')
    .leftJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'p.tenant_id').onRef('s.id', '=', 'p.store_id'),
    )
    .leftJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'p.tenant_id').onRef('a.id', '=', 'p.settlement_account_id'),
    )
    .select([
      'p.id',
      'p.store_id',
      's.name as store_name',
      'p.provider',
      'p.display_name',
      'p.mode',
      'p.vpa',
      'p.payee_name',
      'p.merchant_code',
      'p.config',
      'p.settlement_account_id',
      'a.name as settlement_account_name',
      'p.is_default',
      'p.is_active',
      'p.last_verified_at',
      'p.created_at',
      'p.updated_at',
    ])
    .select([
      sql<boolean>`p.credentials_encrypted is not null`.as('has_credentials'),
      sql<boolean>`p.webhook_secret_encrypted is not null`.as('has_webhook_secret'),
    ])
    .where('p.tenant_id', '=', ctx.tenantId)
}

type AccountRow = Awaited<ReturnType<ReturnType<typeof accountQuery>['executeTakeFirstOrThrow']>>

export function toProviderAccount(row: AccountRow, publicBaseUrl: string): PaymentProviderAccount {
  const provider = row.provider as PaymentProviderCode
  const caps = PROVIDER_CAPABILITIES[provider]
  const config = readProviderConfig(row.config)
  return {
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name,
    provider,
    display_name: row.display_name,
    mode: row.mode === 'test' ? 'test' : 'live',
    vpa: row.vpa,
    payee_name: row.payee_name,
    merchant_code: row.merchant_code,
    key_id_masked: provider === 'razorpay' ? (config.key_id_masked ?? null) : null,
    has_credentials: row.has_credentials,
    has_webhook_secret: row.has_webhook_secret,
    webhook_url: caps.webhooks ? `${publicBaseUrl}${paymentWebhookPath(provider, row.id)}` : null,
    webhook_events: provider === 'razorpay' ? [...RAZORPAY_WEBHOOK_EVENTS] : [],
    settlement_account_id: row.settlement_account_id,
    settlement_account_name: row.settlement_account_name,
    is_default: row.is_default,
    is_active: row.is_active,
    last_verified_at: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    capabilities: caps,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export async function listProviders(
  tx: Tx,
  ctx: Ctx,
  query: ListQuery,
  publicBaseUrl: string,
): Promise<PageEnvelope<PaymentProviderAccount>> {
  const page = parsePage(query)
  let q = accountQuery(tx, ctx)
  // Visible: the all-stores accounts and those of the member's stores.
  if (ctx.storeIds !== null) {
    const ids = [...ctx.storeIds]
    q = q.where((eb) =>
      ids.length
        ? eb.or([eb('p.store_id', 'is', null), eb('p.store_id', 'in', ids)])
        : eb('p.store_id', 'is', null),
    )
  }
  if (query.store_id) {
    assertStoreAccess(ctx, query.store_id)
    const storeId = query.store_id
    q = q.where((eb) => eb.or([eb('p.store_id', 'is', null), eb('p.store_id', '=', storeId)]))
  }
  if (query.provider?.length) q = q.where('p.provider', 'in', query.provider)
  if (query.is_active !== undefined) q = q.where('p.is_active', '=', query.is_active)
  const rows = await q
    .select(sql<number>`count(*) over()`.as('__total'))
    .orderBy('p.is_active', 'desc')
    .orderBy('p.is_default', 'desc')
    .orderBy('p.display_name')
    .orderBy('p.id')
    .limit(page.limit)
    .offset(page.offset)
    .execute()
  let total = rows[0] ? Number(rows[0].__total) : 0
  if (rows.length === 0 && page.offset > 0) {
    const c = await q
      .clearSelect()
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst()
    total = Number(c?.n ?? 0)
  }
  return {
    data: rows.map((r) => toProviderAccount(r, publicBaseUrl)),
    page: { limit: page.limit, offset: page.offset, total },
  }
}

async function loadRow(tx: Tx, ctx: Ctx, id: string, forUpdate = false): Promise<AccountRow> {
  let q = accountQuery(tx, ctx).where('p.id', '=', id)
  if (forUpdate) q = q.forUpdate(['p'])
  const row = await q.executeTakeFirst()
  if (!row || (row.store_id && !canAccessStore(ctx, row.store_id))) {
    throw notFound('payment_provider_account', id)
  }
  return row
}

export async function getProviderAccount(
  tx: Tx,
  ctx: Ctx,
  id: string,
  publicBaseUrl: string,
): Promise<PaymentProviderAccount> {
  return toProviderAccount(await loadRow(tx, ctx, id), publicBaseUrl)
}

/**
 * Loads an account for a provider call (credentials decrypted). The payee name defaults to the
 * shop name. Store access is the caller's concern (intents check their store).
 */
export async function loadAccountRuntime(
  deps: Pick<KadaiDeps, 'crypto'>,
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  id: string,
): Promise<
  ProviderAccountRuntime & {
    is_active: boolean
    store_id: string | null
    settlement_account_id: string | null
  }
> {
  const row = await tx
    .selectFrom('payment_provider_accounts')
    .select([
      'id',
      'tenant_id',
      'provider',
      'mode',
      'display_name',
      'vpa',
      'payee_name',
      'merchant_code',
      'credentials_encrypted',
      'config',
      'is_active',
      'store_id',
      'settlement_account_id',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw notFound('payment_provider_account', id)
  const shop = await loadShop(tx, ctx)
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider as PaymentProviderCode,
    mode: row.mode === 'test' ? 'test' : 'live',
    display_name: row.display_name,
    vpa: row.vpa,
    payee_name: (row.payee_name ?? shop.name).slice(0, 50),
    merchant_code: row.merchant_code,
    credentials: row.credentials_encrypted
      ? decryptCredentials(deps, row.tenant_id, row.id, row.credentials_encrypted)
      : null,
    config: readProviderConfig(row.config),
    is_active: row.is_active,
    store_id: row.store_id,
    settlement_account_id: row.settlement_account_id,
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** Store scope checks for writing an account of `storeId` (null = all stores). */
async function assertScopeWritable(tx: Tx, ctx: Ctx, storeId: string | null): Promise<void> {
  if (storeId === null) {
    if (ctx.storeIds !== null) {
      throw forbidden('Only members with access to every store can manage all-store accounts', {
        reason: 'all_stores_required',
      })
    }
    return
  }
  assertStoreAccess(ctx, storeId)
  const store = await tx
    .selectFrom('stores')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!store)
    throw reasonError('UNPROCESSABLE', 'Store not found', 'store_not_found', { store_id: storeId })
}

/** Settlement account must be an active bank account of the chart. */
async function assertSettlementAccount(tx: Tx, ctx: Ctx, accountId: string): Promise<void> {
  const row = await tx
    .selectFrom('accounts')
    .select(['id', 'type', 'subtype', 'is_active', 'parent_id', 'details'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst()
  const invalid = () =>
    reasonError(
      'UNPROCESSABLE',
      'The settlement account must be an active bank account',
      'settlement_account_not_bank',
      { settlement_account_id: accountId },
    )
  if (!row || !row.is_active) throw invalid()
  const ancestors: (string | null)[] = []
  let parentId = row.parent_id
  for (let depth = 0; parentId && depth < 8; depth++) {
    const parent = await tx
      .selectFrom('accounts')
      .select(['subtype', 'parent_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', parentId)
      .executeTakeFirst()
    if (!parent) break
    ancestors.push(parent.subtype)
    parentId = parent.parent_id
  }
  const details = recordOf(row.details)
  const kind = moneyKindOf({
    type: row.type as 'asset',
    subtype: row.subtype,
    ancestor_subtypes: ancestors,
    has_bank_details: Boolean(details.bank_name || details.account_last4 || details.ifsc),
  })
  if (kind !== 'bank') throw invalid()
}

async function lockScope(tx: Tx, ctx: Ctx, storeId: string | null): Promise<void> {
  const key = `payments.default:${ctx.tenantId}:${storeId ?? 'all'}`
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

async function hasDefault(
  tx: Tx,
  ctx: Ctx,
  storeId: string | null,
  exceptId: string,
): Promise<boolean> {
  const row = await tx
    .selectFrom('payment_provider_accounts')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', storeId === null ? 'is' : '=', storeId)
    .where('is_default', '=', true)
    .where('is_active', '=', true)
    .where('id', '<>', exceptId)
    .executeTakeFirst()
  return Boolean(row)
}

/** Makes `id` the only default of its scope (caller holds the scope lock). */
async function switchDefault(tx: Tx, ctx: Ctx, id: string, storeId: string | null): Promise<void> {
  await tx
    .updateTable('payment_provider_accounts')
    .set({ is_default: false })
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', storeId === null ? 'is' : '=', storeId)
    .where('is_default', '=', true)
    .where('id', '<>', id)
    .execute()
  await tx
    .updateTable('payment_provider_accounts')
    .set({ is_default: true })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
}

async function assertProviderAllowed(
  deps: Deps,
  ctx: Ctx,
  provider: PaymentProviderCode,
): Promise<void> {
  if (provider === 'mock' && !deps.config.enableMockPayments) {
    throw reasonError(
      'UNPROCESSABLE',
      'Mock payments are disabled on this server',
      'mock_payments_disabled',
    )
  }
  await assertFeature(ctx, isDynamicProvider(provider) ? 'upi_dynamic' : 'upi_static')
}

export async function createProviderAccount(
  deps: Deps,
  tx: Tx,
  ctx: Ctx,
  body: PaymentProviderCreateParsed,
): Promise<PaymentProviderAccount> {
  await assertProviderAllowed(deps, ctx, body.provider)
  const storeId = body.store_id ?? null
  await assertScopeWritable(tx, ctx, storeId)
  if (body.settlement_account_id) await assertSettlementAccount(tx, ctx, body.settlement_account_id)
  const shop = await loadShop(tx, ctx)
  const id = newId()
  let mode: 'test' | 'live' = 'live'
  let vpa: string | null = null
  let payeeName: string | null = null
  let merchantCode: string | null = null
  let credentials: string | null = null
  let webhookSecret: string | null = null
  const config: ProviderConfig = {}
  const mcc = defaultMccFor(shop.business_type as BusinessType)
  switch (body.provider) {
    case 'upi_vpa':
      vpa = body.vpa
      payeeName = body.payee_name
      merchantCode = body.merchant_code ?? mcc
      break
    case 'razorpay':
      mode = body.mode
      payeeName = body.payee_name ?? shop.name.slice(0, 50)
      merchantCode = body.merchant_code ?? mcc
      credentials = encryptCredentials(deps, ctx.tenantId, id, body.credentials)
      config.key_id_masked = maskKeyId(body.credentials.key_id)
      webhookSecret = body.webhook_secret
        ? encryptWebhookSecret(deps, ctx.tenantId, id, body.webhook_secret)
        : null
      break
    case 'mock':
      mode = 'test'
      payeeName = shop.name.slice(0, 50)
      merchantCode = mcc
      config.auto_pay_delay_ms = body.auto_pay_delay_ms ?? 0
      break
  }
  await lockScope(tx, ctx, storeId)
  await tx
    .insertInto('payment_provider_accounts')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: storeId,
      provider: body.provider,
      display_name: body.display_name,
      mode,
      vpa,
      payee_name: payeeName,
      merchant_code: merchantCode,
      credentials_encrypted: credentials,
      webhook_secret_encrypted: webhookSecret,
      config: jsonb(config),
      settlement_account_id: body.settlement_account_id ?? null,
      is_default: false,
      is_active: true,
      created_by: ctx.userId,
    })
    .execute()
  const makeDefault = body.is_default ?? !(await hasDefault(tx, ctx, storeId, id))
  if (makeDefault) await switchDefault(tx, ctx, id, storeId)
  const account = toProviderAccount(await loadRow(tx, ctx, id), deps.config.publicBaseUrl)
  await audit(tx, ctx, {
    action: 'payment_provider.create',
    entity_type: 'payment_provider_account',
    entity_id: id,
    summary: `${body.provider} account "${body.display_name}" added`,
    changes: { after: auditView(account) },
  })
  return account
}

/** Non-secret fields recorded in the audit trail. */
function auditView(a: PaymentProviderAccount) {
  return {
    provider: a.provider,
    display_name: a.display_name,
    store_id: a.store_id,
    mode: a.mode,
    vpa: a.vpa,
    payee_name: a.payee_name,
    merchant_code: a.merchant_code,
    key_id_masked: a.key_id_masked,
    has_credentials: a.has_credentials,
    has_webhook_secret: a.has_webhook_secret,
    settlement_account_id: a.settlement_account_id,
    is_default: a.is_default,
    is_active: a.is_active,
  }
}

/** Fields of the PATCH body that apply to each provider. */
const UPDATABLE: Readonly<Record<'upi_vpa' | 'razorpay' | 'mock', readonly (keyof UpdateBody)[]>> =
  {
    upi_vpa: ['vpa', 'payee_name', 'merchant_code'],
    razorpay: ['mode', 'payee_name', 'merchant_code', 'credentials', 'webhook_secret'],
    mock: ['payee_name', 'merchant_code', 'auto_pay_delay_ms'],
  }
const PROVIDER_SPECIFIC: readonly (keyof UpdateBody)[] = [
  'vpa',
  'payee_name',
  'merchant_code',
  'mode',
  'credentials',
  'webhook_secret',
  'auto_pay_delay_ms',
]

export async function updateProviderAccount(
  deps: Deps,
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: UpdateBody,
): Promise<PaymentProviderAccount> {
  const before = await loadRow(tx, ctx, id, true)
  if (before.store_id === null && ctx.storeIds !== null) await assertScopeWritable(tx, ctx, null)
  assertNotStale(before.updated_at, body.if_updated_at, 'payment_provider_account', id)
  const provider = before.provider as PaymentProviderCode
  if (provider !== 'upi_vpa' && provider !== 'razorpay' && provider !== 'mock') {
    throw reasonError(
      'UNPROCESSABLE',
      `No adapter for the ${provider} provider`,
      'provider_not_implemented',
    )
  }
  const allowed = UPDATABLE[provider]
  const notApplicable = PROVIDER_SPECIFIC.filter(
    (k) => body[k] !== undefined && !allowed.includes(k),
  )
  if (notApplicable.length) {
    throw reasonError(
      'UNPROCESSABLE',
      `Fields not applicable to a ${provider} account: ${notApplicable.join(', ')}`,
      'field_not_applicable',
      { fields: notApplicable },
    )
  }
  if (provider === 'upi_vpa' && body.payee_name === null) {
    throw reasonError('UNPROCESSABLE', 'A UPI ID needs a payee name', 'payee_name_required')
  }

  const storeId = body.store_id !== undefined ? body.store_id : before.store_id
  if (body.store_id !== undefined && body.store_id !== before.store_id) {
    await assertScopeWritable(tx, ctx, storeId)
  }
  if (body.settlement_account_id) await assertSettlementAccount(tx, ctx, body.settlement_account_id)
  const isActive = body.is_active ?? before.is_active
  if (body.is_default === true && !isActive) {
    throw reasonError(
      'UNPROCESSABLE',
      'An inactive account cannot be the default',
      'inactive_default',
    )
  }
  if (body.is_active === true && !before.is_active) await assertProviderAllowed(deps, ctx, provider)

  const config = readProviderConfig(before.config)
  const set: Record<string, unknown> = {}
  if (body.display_name !== undefined) set.display_name = body.display_name
  if (body.store_id !== undefined) set.store_id = body.store_id
  if (body.vpa !== undefined) set.vpa = body.vpa
  if (body.payee_name !== undefined) set.payee_name = body.payee_name
  if (body.merchant_code !== undefined) set.merchant_code = body.merchant_code
  if (body.settlement_account_id !== undefined)
    set.settlement_account_id = body.settlement_account_id
  if (body.is_active !== undefined) set.is_active = body.is_active
  const nextMode = body.mode ?? (before.mode === 'test' ? 'test' : 'live')
  if (body.mode !== undefined) set.mode = body.mode
  let credentialsRotated = false
  if (provider === 'razorpay') {
    let keyId: string | null = null
    if (body.credentials) {
      set.credentials_encrypted = encryptCredentials(deps, ctx.tenantId, id, body.credentials)
      config.key_id_masked = maskKeyId(body.credentials.key_id)
      keyId = body.credentials.key_id
      credentialsRotated = true
    } else if (body.mode !== undefined) {
      const row = await tx
        .selectFrom('payment_provider_accounts')
        .select('credentials_encrypted')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      keyId = row.credentials_encrypted
        ? decryptCredentials(deps, ctx.tenantId, id, row.credentials_encrypted).key_id
        : null
    }
    if (keyId !== null && !keyId.startsWith(`rzp_${nextMode}_`)) {
      throw reasonError(
        'UNPROCESSABLE',
        'The key id does not match the account mode',
        'razorpay_key_mode_mismatch',
        { mode: nextMode },
      )
    }
    if (body.webhook_secret !== undefined) {
      set.webhook_secret_encrypted =
        body.webhook_secret === null
          ? null
          : encryptWebhookSecret(deps, ctx.tenantId, id, body.webhook_secret)
    }
  }
  if (provider === 'mock' && body.auto_pay_delay_ms !== undefined) {
    config.auto_pay_delay_ms = body.auto_pay_delay_ms
  }
  set.config = jsonb(config)

  const scopeChanged = storeId !== before.store_id
  if (!isActive) set.is_default = false
  if (scopeChanged) {
    await lockScope(tx, ctx, storeId)
    if (before.is_default) set.is_default = false
  }
  await tx
    .updateTable('payment_provider_accounts')
    .set(set)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  const wantsDefault =
    isActive &&
    (body.is_default === true ||
      (scopeChanged && before.is_default && body.is_default !== false) ||
      (body.is_active === true &&
        !before.is_active &&
        body.is_default !== false &&
        !(await hasDefault(tx, ctx, storeId, id))))
  if (wantsDefault) {
    if (!scopeChanged) await lockScope(tx, ctx, storeId)
    await switchDefault(tx, ctx, id, storeId)
  } else if (body.is_default === false && before.is_default) {
    await tx
      .updateTable('payment_provider_accounts')
      .set({ is_default: false })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
  }
  const after = toProviderAccount(await loadRow(tx, ctx, id), deps.config.publicBaseUrl)
  const beforeView = auditView(toProviderAccount(before, deps.config.publicBaseUrl))
  const diff = diffChanges(beforeView, auditView(after))
  await audit(tx, ctx, {
    action: 'payment_provider.update',
    entity_type: 'payment_provider_account',
    entity_id: id,
    summary: `${provider} account "${after.display_name}" updated`,
    changes: {
      ...(diff ?? { before: {}, after: {} }),
      ...(credentialsRotated ? { credentials_rotated: true } : {}),
      ...(body.webhook_secret !== undefined
        ? { webhook_secret: body.webhook_secret === null ? 'removed' : 'replaced' }
        : {}),
    },
  })
  return after
}

/** DELETE /payment-providers/:id — deactivates (history and intents keep referring to it). */
export async function deactivateProviderAccount(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const row = await loadRow(tx, ctx, id, true)
  if (row.store_id === null) await assertScopeWritable(tx, ctx, null)
  if (!row.is_active) return
  await tx
    .updateTable('payment_provider_accounts')
    .set({ is_active: false, is_default: false })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'payment_provider.deactivate',
    entity_type: 'payment_provider_account',
    entity_id: id,
    summary: `${row.provider} account "${row.display_name}" deactivated`,
    changes: {
      before: { is_active: true, is_default: row.is_default },
      after: { is_active: false, is_default: false },
    },
  })
}

/** Records a successful credentials check. */
export async function markVerified(tx: Tx, ctx: Ctx, id: string, at: Date): Promise<void> {
  await tx
    .updateTable('payment_provider_accounts')
    .set({ last_verified_at: at })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
}

/** Throws NOT_FOUND unless `id` is an account the member can see (route param guard). */
export async function assertVisibleAccount(tx: Tx, ctx: Ctx, id: string): Promise<AccountRow> {
  if (!isUuid(id)) throw notFound('payment_provider_account', id)
  return loadRow(tx, ctx, id)
}
