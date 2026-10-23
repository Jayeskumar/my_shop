/**
 * View or edit a role. Built-in (system) roles open read-only with their effective permissions
 * and a "copy as a new role" shortcut; custom roles (plan feature custom_roles) edit name,
 * Tamil name, description and the permission matrix, and can be deleted when nobody has them.
 */
import { Copy, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  RoleCreateSchema,
  RoleUpdateSchema,
  type Role,
  type RoleUpdate,
} from '@kadai/shared/api/identity'
import type { Permission } from '@kadai/shared/permissions'
import { Badge, Button, ConfirmDialog, Dialog, Input, Skeleton, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useCreateRole, useDeleteRole, usePermissionCatalog, useUpdateRole } from '../api'
import { changedTopLevel, contractResolver, textOrNull } from '../lib/forms'
import { roleLabel } from '../lib/members'
import { roleCodeFromName } from '../lib/role-permissions'
import {
  errorReason,
  notifySettingsError,
  planBlockOf,
  reasonText,
  useValidationKeyText,
  type PlanBlock,
} from '../lib/messages'
import { PermissionMatrix } from './PermissionMatrix'
import { SettingsField } from './SettingsField'
import { UpgradeHint } from './UpgradeHint'

interface RoleFormValues {
  name: string
  name_ta: string
  description: string
  code: string
}

/** What the dialog shows: an existing role, or a new one (optionally copied from a role). */
export type RoleEditorTarget = { kind: 'view'; role: Role } | { kind: 'new'; from: Role | null }

function bodyOf(v: RoleFormValues, permissions: readonly Permission[]) {
  return {
    name: v.name.trim(),
    name_ta: textOrNull(v.name_ta),
    description: textOrNull(v.description),
    permissions: [...permissions].sort(),
  }
}

export function RoleEditorDialog({
  open,
  onOpenChange,
  target,
  canEdit,
  canCreate,
  onCopy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: RoleEditorTarget | null
  /** users.manage + every store (role writes are business-wide). */
  canEdit: boolean
  /** canEdit + plan feature custom_roles. */
  canCreate: boolean
  onCopy: (role: Role) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const keyText = useValidationKeyText()
  const catalog = usePermissionCatalog()
  const myPermissions = useAuth((s) => s.permissions)
  const iAmOwner = useAuth((s) => s.me?.membership.role_code === 'owner')
  const role = target?.kind === 'view' ? target.role : null
  const isNew = target?.kind === 'new'
  const editable = isNew ? canCreate : Boolean(role?.editable) && canEdit
  const [selected, setSelected] = useState<Set<Permission>>(new Set())
  const [permError, setPermError] = useState<string | null>(null)
  const [block, setBlock] = useState<PlanBlock | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const form = useForm<RoleFormValues>({
    defaultValues: { name: '', name_ta: '', description: '', code: '' },
    resolver: contractResolver<RoleFormValues>(
      isNew ? RoleCreateSchema : RoleUpdateSchema,
      // Permissions are checked separately (matrix state), so a placeholder keeps them valid here.
      (v) => ({
        ...bodyOf(v, ['pos.use']),
        ...(isNew && v.code.trim() ? { code: v.code.trim() } : {}),
      }),
      (p) => (p.startsWith('permissions') ? null : p),
    ),
    mode: 'onTouched',
  })
  const nameValue = useWatch({ control: form.control, name: 'name' })
  // What the server will use when the code is left empty.
  const codePlaceholder = nameValue.trim() ? roleCodeFromName(nameValue) : 'senior_cashier'
  const create = useCreateRole()
  const update = useUpdateRole()
  const remove = useDeleteRole()
  const saving = create.isPending || update.isPending

  useEffect(() => {
    if (!open || !target) return
    setPermError(null)
    setBlock(null)
    if (target.kind === 'view') {
      const r = target.role
      form.reset({
        name: r.name,
        name_ta: r.name_ta ?? '',
        description: r.description ?? '',
        code: r.code,
      })
      setSelected(new Set(r.editable ? (r.permissions as Permission[]) : r.effective_permissions))
    } else {
      const from = target.from
      form.reset({
        name: from ? t('roles.copy_name', { name: from.name }) : '',
        name_ta: from?.name_ta ? t('roles.copy_name', { name: from.name_ta }) : '',
        description: from?.description ?? '',
        code: '',
      })
      // Only what the editor may grant is copied.
      const perms = from ? from.effective_permissions : []
      setSelected(new Set(iAmOwner ? perms : perms.filter((p) => myPermissions.has(p))))
    }
  }, [open, target, form, t, iAmOwner, myPermissions])

  const grantable = useMemo(
    () => (iAmOwner ? null : (myPermissions as ReadonlySet<Permission>)),
    [iAmOwner, myPermissions],
  )

  const handleError = (error: unknown): void => {
    const plan = planBlockOf(error)
    if (plan) {
      setBlock(plan)
      return
    }
    if (errorReason(error) === 'role_code_reserved') {
      form.setError('code', { type: 'server', message: reasonText(error) ?? '' })
      return
    }
    if (isApiError(error) && error.code === 'DUPLICATE') {
      form.setError('name', { type: 'server', message: t('roles.duplicate') })
      return
    }
    if (isApiError(error) && error.code === 'STALE_WRITE') {
      notify.error(t('common.stale_write'))
      return
    }
    if (!applyServerFieldErrors(error, form.setError, ['name', 'name_ta', 'description', 'code']))
      notifySettingsError(error)
  }

  const submit = form.handleSubmit(async (values) => {
    if (selected.size === 0) {
      setPermError(t('roles.permissions_required'))
      return
    }
    try {
      if (isNew) {
        const res = await create.mutateAsync({
          body: {
            ...bodyOf(values, [...selected]),
            ...(values.code.trim() ? { code: values.code.trim() } : {}),
          },
        })
        notify.success(t('roles.created', { name: res.data.name }))
        onOpenChange(false)
        return
      }
      if (!role) return
      const diff = changedTopLevel(
        bodyOf(
          {
            name: role.name,
            name_ta: role.name_ta ?? '',
            description: role.description ?? '',
            code: role.code,
          },
          role.permissions as Permission[],
        ),
        bodyOf(values, [...selected]),
      )
      if (!diff) {
        onOpenChange(false)
        return
      }
      await update.mutateAsync({
        params: { id: role.id },
        body: { ...(diff as RoleUpdate), if_updated_at: role.updated_at },
      })
      notify.success(t('roles.saved', { name: values.name.trim() }))
      onOpenChange(false)
    } catch (error) {
      handleError(error)
    }
  })

  const title = isNew ? t('roles.new_title') : role ? roleLabel(role.name, role.name_ta) : ''

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => !saving && onOpenChange(o)}
        title={title}
        description={
          isNew
            ? t('roles.new_description')
            : role?.is_system
              ? t('roles.system_description')
              : (role?.description ?? undefined)
        }
        size="xl"
        dismissible={!editable || !form.formState.isDirty}
        footer={
          <>
            {role && role.editable && canEdit ? (
              <Button
                variant="ghost"
                className="me-auto text-danger"
                leftIcon={<Trash2 />}
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                {t('roles.delete')}
              </Button>
            ) : null}
            {role && canCreate ? (
              <Button variant="outline" leftIcon={<Copy />} onClick={() => onCopy(role)}>
                {t('roles.copy')}
              </Button>
            ) : null}
            {editable ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" form="role-form" loading={saving}>
                  {isNew ? t('roles.create') : t('common:actions.save_changes')}
                </Button>
              </>
            ) : (
              <Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button>
            )}
          </>
        }
      >
        <FormProvider {...form}>
          <form
            id="role-form"
            onSubmit={(e) => void submit(e)}
            noValidate
            className="flex flex-col gap-4"
          >
            {block ? <UpgradeHint block={block} /> : null}
            {role ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {role.is_system ? (
                  <Badge tone="info" icon={<ShieldCheck />}>
                    {t('roles.system_badge')}
                  </Badge>
                ) : (
                  <Badge tone="accent">{t('roles.custom_badge')}</Badge>
                )}
                <code className="text-xs text-muted-foreground">{role.code}</code>
                <span className="text-muted-foreground">
                  · {t('roles.members_count', { count: role.member_count })}
                </span>
              </div>
            ) : null}
            {editable ? (
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <SettingsField name="name" label={t('roles.name')} required>
                  <Input {...form.register('name')} maxLength={60} autoFocus />
                </SettingsField>
                <SettingsField name="name_ta" label={t('roles.name_ta')} optional>
                  <Input {...form.register('name_ta')} maxLength={60} lang="ta" />
                </SettingsField>
                <SettingsField
                  name="description"
                  label={t('roles.description_field')}
                  optional
                  className="sm:col-span-2"
                >
                  <Input {...form.register('description')} maxLength={300} />
                </SettingsField>
                {isNew ? (
                  <SettingsField
                    name="code"
                    label={t('roles.code')}
                    hint={t('roles.code_hint')}
                    optional
                  >
                    <Input
                      {...form.register('code')}
                      maxLength={40}
                      className="font-mono"
                      placeholder={codePlaceholder}
                    />
                  </SettingsField>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('roles.permissions')}</h3>
              {permError ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {keyText(permError) ?? permError}
                </p>
              ) : null}
              {catalog.data ? (
                <PermissionMatrix
                  catalog={catalog.data.data}
                  selected={selected}
                  readOnly={!editable}
                  grantable={grantable}
                  onChange={(next) => {
                    setSelected(next)
                    setPermError(null)
                  }}
                />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2" aria-busy>
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-40 rounded-xl" />
                  ))}
                </div>
              )}
            </div>
            {!isNew && role?.is_system ? (
              <p className="text-xs text-muted-foreground">{t('roles.system_note')}</p>
            ) : null}
          </form>
        </FormProvider>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        title={t('roles.delete_title', { name: role?.name ?? '' })}
        description={t('roles.delete_description')}
        confirmLabel={t('roles.delete')}
        onConfirm={async () => {
          if (!role) return
          try {
            await remove.mutateAsync({ params: { id: role.id } })
            notify.success(t('roles.deleted', { name: role.name }))
            onOpenChange(false)
          } catch (error) {
            notifySettingsError(error)
            throw error
          }
        }}
      />
    </>
  )
}
