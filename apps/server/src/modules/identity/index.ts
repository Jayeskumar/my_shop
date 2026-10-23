/**
 * identity module — users, roles, stores, registers, devices, settings, number series, audit log,
 * files. Owned by the identity module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "identity". Every route is registered from the shared catalogue
 * (`identityRoutes` in @kadai/shared/api/identity): method, path, schemas, permission / feature
 * guards and the idempotency-key check come from the contract. `{ tx }` implementations run in
 * ONE tenant transaction (RLS); the few system-database steps (global user identities,
 * auth_sessions) are documented in ./users.ts and ./devices.ts. Background jobs: ./jobs.ts.
 */
import type { FastifyReply } from 'fastify'
import {
  type MemberCreateResult,
  identityRoutes,
  permissionCatalog,
} from '@kadai/shared/api/identity'
import type { RouteResponse } from '@kadai/shared/api/common'
import {
  type RouteImpls,
  type RouteRequestFor,
  idempotencyKeyOf,
  routePlugins,
} from '../../core/http'
import { requestHash, runIdempotent } from '../../core/idempotency'
import { defineModule } from '../module'
import { listAuditLogs } from './audit-logs'
import { createDevice, listDevices, revokeDevice } from './devices'
import { assertUploadPermission, readUpload, sendFileContent, toFileMeta } from './files'
import { createNumberSeries, listNumberSeries, updateNumberSeries } from './number-series'
import { createRole, deleteRole, getRole, listRoles, updateRole } from './roles'
import {
  getBusinessProfile,
  getSettingsResponse,
  patchSettings,
  updateBusinessProfile,
} from './settings'
import {
  createRegister,
  createStore,
  getRegister,
  getStore,
  listRegisters,
  listStores,
  updateRegister,
  updateStore,
} from './stores'
import {
  createMember,
  disableMember,
  enableMember,
  getVisibleMember,
  listMembers,
  resetMemberPassword,
  resetMemberPin,
  updateMember,
  userDirectory,
} from './users'

type Routes = typeof identityRoutes
type CreateUserResponse = RouteResponse<Routes['createUser']>

/**
 * POST /users, idempotent on `Idempotency-Key`: a retry with the same key and body replays the
 * stored response. The one-time temporary password is never stored — the replay answers
 * `temporary_password: null` (the admin can reset the password) — and the request hash leaves
 * out the password and PIN so no secret is kept in idempotency_keys.
 */
async function createUserRoute(
  req: RouteRequestFor<Routes['createUser']>,
  reply: FastifyReply,
): Promise<CreateUserResponse> {
  const deps = req.server.kadai
  const key = idempotencyKeyOf(req)
  if (!key) return { data: await req.tx((tx) => createMember(deps, tx, req.ctx, req.body)) }
  let fresh: MemberCreateResult | null = null
  const outcome = await req.tx((tx) =>
    runIdempotent<CreateUserResponse>(
      tx,
      req.ctx,
      {
        key,
        method: req.method,
        path: req.routeOptions.url ?? '/users',
        requestHash: requestHash(
          {
            ...req.body,
            password: req.body.password ? 'set' : null,
            pin: req.body.pin ? 'set' : null,
          },
          { query: null, params: null },
        ),
      },
      async () => {
        const result = await createMember(deps, tx, req.ctx, req.body)
        fresh = result
        const stored = identityRoutes.createUser.response.parse({
          data: { ...result, temporary_password: null },
        })
        return { status: 201, body: JSON.parse(JSON.stringify(stored)) as CreateUserResponse }
      },
    ),
  )
  reply.header('idempotent-replayed', String(outcome.replayed))
  return !outcome.replayed && fresh ? { data: fresh } : outcome.body
}

export const identityImpls: RouteImpls<Routes> = {
  // ---- users ---------------------------------------------------------------------------------
  listUsers: { tx: (tx, req) => listMembers(tx, req.ctx, req.query) },
  userDirectory: {
    tx: async (tx, req) => ({ data: await userDirectory(tx, req.ctx, req.query) }),
  },
  createUser: { handler: createUserRoute },
  getUser: {
    tx: async (tx, req) => ({ data: await getVisibleMember(tx, req.ctx, req.params.id) }),
  },
  updateUser: {
    tx: async (tx, req) => ({
      data: await updateMember(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  disableUser: {
    tx: async (tx, req) => ({
      data: await disableMember(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  enableUser: {
    tx: async (tx, req) => ({
      data: await enableMember(req.server.kadai, tx, req.ctx, req.params.id),
    }),
  },
  resetUserPin: {
    tx: async (tx, req) => ({
      data: await resetMemberPin(tx, req.ctx, req.params.id, req.body),
    }),
  },
  resetUserPassword: {
    tx: async (tx, req) => ({
      data: await resetMemberPassword(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },

  // ---- roles & permissions -------------------------------------------------------------------
  listRoles: { tx: (tx, req) => listRoles(tx, req.ctx, req.query) },
  createRole: { tx: async (tx, req) => ({ data: await createRole(tx, req.ctx, req.body) }) },
  getRole: { tx: async (tx, req) => ({ data: await getRole(tx, req.ctx, req.params.id) }) },
  updateRole: {
    tx: async (tx, req) => ({
      data: await updateRole(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteRole: {
    tx: async (tx, req) => {
      await deleteRole(req.server.kadai, tx, req.ctx, req.params.id)
    },
  },
  listPermissions: async () => ({ data: permissionCatalog() }),

  // ---- stores, registers, devices ------------------------------------------------------------
  listStores: { tx: (tx, req) => listStores(tx, req.ctx, req.query) },
  createStore: { tx: async (tx, req) => ({ data: await createStore(tx, req.ctx, req.body) }) },
  getStore: { tx: async (tx, req) => ({ data: await getStore(tx, req.ctx, req.params.id) }) },
  updateStore: {
    tx: async (tx, req) => ({ data: await updateStore(tx, req.ctx, req.params.id, req.body) }),
  },
  listRegisters: { tx: (tx, req) => listRegisters(tx, req.ctx, req.query) },
  createRegister: {
    tx: async (tx, req) => ({ data: await createRegister(tx, req.ctx, req.body) }),
  },
  getRegister: {
    tx: async (tx, req) => ({ data: await getRegister(tx, req.ctx, req.params.id) }),
  },
  updateRegister: {
    tx: async (tx, req) => ({
      data: await updateRegister(tx, req.ctx, req.params.id, req.body),
    }),
  },
  listDevices: { tx: (tx, req) => listDevices(tx, req.ctx, req.query) },
  createDevice: {
    tx: async (tx, req) => ({
      data: await createDevice(req.server.kadai, tx, req.ctx, req.body),
    }),
  },
  revokeDevice: {
    tx: async (tx, req) => ({
      data: await revokeDevice(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },

  // ---- settings ------------------------------------------------------------------------------
  getSettings: { tx: async (tx, req) => ({ data: await getSettingsResponse(tx, req.ctx) }) },
  updateSettings: {
    tx: async (tx, req) => ({ data: await patchSettings(tx, req.ctx, req.body) }),
  },
  getBusinessProfile: {
    tx: async (tx, req) => ({ data: await getBusinessProfile(tx, req.ctx) }),
  },
  updateBusinessProfile: {
    tx: async (tx, req) => ({
      data: await updateBusinessProfile(req.server.kadai, tx, req.ctx, req.body),
    }),
  },

  // ---- number series -------------------------------------------------------------------------
  listNumberSeries: {
    tx: async (tx, req) => ({ data: await listNumberSeries(tx, req.ctx, req.query) }),
  },
  createNumberSeries: {
    tx: async (tx, req) => ({ data: await createNumberSeries(tx, req.ctx, req.body) }),
  },
  updateNumberSeries: {
    tx: async (tx, req) => ({
      data: await updateNumberSeries(tx, req.ctx, req.params.id, req.body),
    }),
  },

  // ---- audit log -----------------------------------------------------------------------------
  listAuditLogs: { tx: (tx, req) => listAuditLogs(tx, req.ctx, req.query) },

  // ---- files ---------------------------------------------------------------------------------
  uploadFile: async (req) => {
    const files = req.server.kadai.files
    const purpose = req.query.purpose
    assertUploadPermission(req.ctx, purpose)
    const upload = await readUpload(req, purpose)
    const row = await req.tx((tx) => files.saveFile(tx, req.ctx, { purpose, ...upload }))
    return { data: toFileMeta(row) }
  },
  getFile: {
    tx: async (tx, req) => ({
      data: toFileMeta(await req.server.kadai.files.getFileRow(tx, req.ctx, req.params.id)),
    }),
  },
  getFileContent: async (req, reply) => {
    const files = req.server.kadai.files
    const row = await req.tx((tx) => files.getFileRow(tx, req.ctx, req.params.id))
    return sendFileContent(files, req, reply, row, req.query.download === true)
  },
}

export const identityModule = defineModule({
  name: 'identity',
  ...routePlugins(identityRoutes, identityImpls),
})
