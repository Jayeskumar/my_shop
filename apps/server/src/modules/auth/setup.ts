/**
 * On-prem first-run wizard (ARCHITECTURE.md §2): GET /setup/status · POST /setup create the single
 * tenant and its owner through onboarding. Setup is done once system_settings holds the
 * 'onprem_setup' marker — or, defensively, once any tenant exists (an on-prem database has
 * exactly one). With KADAI_SETUP_TOKEN set, POST /setup must carry that token.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { SetupRequest, SetupStatusResponse } from '@kadai/shared/api/auth'
import type { Config } from '../../config'
import { timingSafeEqualStr } from '../../core/crypto'
import { AppError, forbidden } from '../../core/errors'
import { type CreatedTenant, createTenantTx } from '../../core/onboarding'
import type { DB } from '../../db/schema.generated'
import { jsonb } from '../../db/json'
import { type Tx, withSystemTx } from '../../db/tenant'
import type { RequestMeta } from './session'

export const ONPREM_SETUP_KEY = 'onprem_setup'

async function isSetupDone(db: Kysely<DB> | Tx): Promise<boolean> {
  const marker = await db
    .selectFrom('system_settings')
    .select('key')
    .where('key', '=', ONPREM_SETUP_KEY)
    .executeTakeFirst()
  if (marker) return true
  const tenant = await db.selectFrom('tenants').select('id').limit(1).executeTakeFirst()
  return Boolean(tenant)
}

export async function setupStatus(
  systemDb: Kysely<DB>,
  config: Pick<Config, 'setupToken'>,
  version: string,
): Promise<SetupStatusResponse> {
  return {
    setup_required: !(await isSetupDone(systemDb)),
    mode: 'onprem',
    version,
    token_required: Boolean(config.setupToken),
  }
}

/**
 * Runs the wizard in one system transaction serialised by an advisory lock, so two browsers
 * racing on a fresh install cannot both create a tenant. @throws 409 SETUP_ALREADY_DONE.
 */
export async function runSetup(
  systemDb: Kysely<DB>,
  config: Pick<Config, 'setupToken'>,
  version: string,
  meta: RequestMeta,
  body: SetupRequest,
): Promise<CreatedTenant> {
  if (config.setupToken && !timingSafeEqualStr(config.setupToken, body.setup_token ?? '')) {
    throw forbidden('The setup token is missing or wrong', { reason: 'setup_token' })
  }
  return withSystemTx(systemDb, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('kadai_onprem_setup', 0))`.execute(tx)
    if (await isSetupDone(tx)) {
      throw new AppError(
        'SETUP_ALREADY_DONE',
        'This installation is already set up; sign in instead',
      )
    }
    const created = await createTenantTx(tx, {
      business_name: body.business_name,
      business_name_ta: body.business_name_ta ?? null,
      legal_name: body.legal_name ?? null,
      business_type: body.business_type,
      gst_scheme: body.gst_scheme,
      gstin: body.gstin,
      state_code: body.state_code,
      locale: body.locale,
      owner: {
        full_name: body.owner_name,
        phone: body.phone,
        email: body.email ?? null,
        password: body.password,
      },
      store_name: body.store_name ?? null,
      mode: 'onprem',
      meta: { ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId },
    })
    await tx
      .insertInto('system_settings')
      .values({
        key: ONPREM_SETUP_KEY,
        value: jsonb({
          tenant_id: created.tenant.id,
          owner_user_id: created.user.id,
          completed_at: new Date().toISOString(),
          version,
        }),
      })
      .execute()
    return created
  })
}
