/**
 * Add or edit an account of the chart (POST /accounts, PATCH /accounts/:id). New accounts take
 * a type, an optional parent of the same type (the code is suggested from it —
 * suggestAccountCode), English and Tamil names, an optional store, and bank details for bank
 * accounts (last 4 digits only, IFSC). System accounts can only be renamed (name, Tamil name,
 * bank details — editable_fields from the server). Edit also offers Deactivate / Activate and
 * Delete when the server allows them (can_deactivate / can_delete).
 */
import { Ban, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccountType } from '@kadai/shared'
import {
  type AccountBalance,
  AccountCreateSchema,
  type AccountDetail,
  AccountUpdateSchema,
  type AccountEditableField,
  type BankDetailsInput,
  suggestAccountCode,
} from '@kadai/shared/api/accounting'
import { AccountTypeSchema } from '@kadai/shared/enums'
import { AccountPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  FormField,
  Input,
  Select,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { useAccount, useCreateAccount, useDeleteAccount, useUpdateAccount } from '../api'
import { notifyAccountingError, validationText } from '../lib/errors'
import { accountName, accountTypeLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'

interface Values {
  type: AccountType
  parent_id: string | null
  code: string
  name: string
  name_ta: string
  store_id: string | null
  is_bank: boolean
  bank_name: string
  account_last4: string
  ifsc: string
  branch: string
  account_holder: string
}

type Errors = Partial<Record<keyof Values | 'form', string>>

const BLANK: Values = {
  type: 'expense',
  parent_id: null,
  code: '',
  name: '',
  name_ta: '',
  store_id: null,
  is_bank: false,
  bank_name: '',
  account_last4: '',
  ifsc: '',
  branch: '',
  account_holder: '',
}

function fromDetail(a: AccountDetail): Values {
  return {
    type: a.type,
    parent_id: a.parent_id,
    code: a.code,
    name: a.name,
    name_ta: a.name_ta ?? '',
    store_id: a.store_id,
    is_bank: a.money_kind === 'bank',
    bank_name: a.details.bank_name ?? '',
    account_last4: a.details.account_last4 ?? '',
    ifsc: a.details.ifsc ?? '',
    branch: a.details.branch ?? '',
    account_holder: a.details.account_holder ?? '',
  }
}

const bankOf = (v: Values): BankDetailsInput => ({
  bank_name: v.bank_name.trim() || null,
  account_last4: v.account_last4.trim() || null,
  ifsc: v.ifsc.trim().toUpperCase() || null,
  branch: v.branch.trim() || null,
  account_holder: v.account_holder.trim() || null,
})

export interface AccountFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this account (else create). */
  accountId?: string | null
  /** Create under this account (type and parent prefilled). */
  parent?: Pick<AccountBalance, 'id' | 'type'> | null
  /** Type of a new account (section "Add" buttons). */
  defaultType?: AccountType
  /** All codes of the chart (code suggestion). */
  existing: readonly Pick<AccountBalance, 'id' | 'code'>[]
  onSaved?: (account: AccountDetail) => void
}

export function AccountFormDialog({
  open,
  onOpenChange,
  accountId,
  parent,
  defaultType,
  existing,
  onSaved,
}: AccountFormDialogProps) {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const confirm = useConfirm()
  const canWrite = useCan('accounting.write')
  const editing = Boolean(accountId)
  const detail = useAccount(open && accountId ? accountId : null)
  const account = detail.data?.data
  const create = useCreateAccount()
  const update = useUpdateAccount()
  const remove = useDeleteAccount()
  const [values, setValues] = useState<Values>(BLANK)
  const [errors, setErrors] = useState<Errors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    if (editing) {
      if (account) setValues(fromDetail(account))
    } else {
      setValues({
        ...BLANK,
        type: canWrite ? (parent?.type ?? defaultType ?? 'expense') : 'expense',
        parent_id: parent?.id ?? null,
      })
    }
  }, [open, editing, account, parent, defaultType, canWrite])

  const editable = useMemo<ReadonlySet<AccountEditableField | 'type'>>(() => {
    if (!editing)
      return new Set(['type', 'code', 'name', 'name_ta', 'parent_id', 'store_id', 'details'])
    return new Set(account?.editable_fields ?? [])
  }, [editing, account])

  const parentCode = existing.find((a) => a.id === values.parent_id)?.code ?? null
  const suggested = useMemo(
    () =>
      suggestAccountCode(
        values.type,
        existing.filter((a) => a.id !== accountId).map((a) => a.code),
        parentCode,
      ),
    [values.type, existing, accountId, parentCode],
  )

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }

  const issuesToErrors = (
    issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
  ): Errors => {
    const out: Errors = {}
    for (const i of issues) {
      const head = String(i.path[0] ?? 'form')
      const key = (head === 'details' ? String(i.path[1] ?? 'form') : head) as keyof Errors
      out[key in BLANK || key === 'form' ? key : 'form'] ??= validationText(i.message) ?? i.message
    }
    return out
  }

  const save = (): void => {
    const showBank = values.type === 'asset' && values.is_bank
    if (!editing) {
      const body = {
        name: values.name.trim(),
        name_ta: values.name_ta.trim() || null,
        type: values.type,
        ...(values.code.trim() ? { code: values.code.trim() } : {}),
        parent_id: values.parent_id,
        store_id: values.store_id,
        ...(showBank ? { details: bankOf(values) } : {}),
      }
      const parsed = AccountCreateSchema.safeParse(body)
      if (!parsed.success) {
        setErrors(issuesToErrors(parsed.error.issues))
        return
      }
      create.mutate(
        { body },
        {
          onSuccess: (res) => {
            notify.success(t('accounts.form.created', { name: accountName(res.data) }))
            onSaved?.(res.data)
            onOpenChange(false)
          },
          onError: notifyAccountingError,
        },
      )
      return
    }
    if (!account) return
    const patch: Record<string, unknown> = {}
    const next = { name: values.name.trim(), name_ta: values.name_ta.trim() || null }
    if (editable.has('name') && next.name !== account.name) patch.name = next.name
    if (editable.has('name_ta') && next.name_ta !== account.name_ta) patch.name_ta = next.name_ta
    if (editable.has('code') && values.code.trim() !== account.code) patch.code = values.code.trim()
    if (editable.has('parent_id') && values.parent_id !== account.parent_id)
      patch.parent_id = values.parent_id
    if (editable.has('store_id') && values.store_id !== account.store_id)
      patch.store_id = values.store_id
    if (editable.has('details') && showBank) {
      const bank = bankOf(values)
      const changed = (Object.keys(bank) as (keyof BankDetailsInput)[]).some(
        (k) => (bank[k] ?? null) !== (account.details[k] ?? null),
      )
      if (changed) patch.details = bank
    }
    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    const body = { ...patch, if_updated_at: account.updated_at }
    const parsed = AccountUpdateSchema.safeParse(body)
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues))
      return
    }
    update.mutate(
      { params: { id: account.id }, body },
      {
        onSuccess: (res) => {
          notify.success(t('accounts.form.updated', { name: accountName(res.data) }))
          onSaved?.(res.data)
          onOpenChange(false)
        },
        onError: notifyAccountingError,
      },
    )
  }

  const toggleActive = async (): Promise<void> => {
    if (!account) return
    const deactivate = account.is_active
    if (deactivate) {
      const ok = await confirm({
        title: t('accounts.form.deactivate_title', { name: accountName(account) }),
        description: t('accounts.form.deactivate_description'),
        confirmLabel: t('accounts.form.deactivate'),
        tone: 'danger',
      })
      if (!ok) return
    }
    update.mutate(
      {
        params: { id: account.id },
        body: { is_active: !deactivate, if_updated_at: account.updated_at },
      },
      {
        onSuccess: (res) => {
          notify.success(
            t(deactivate ? 'accounts.form.deactivated' : 'accounts.form.activated', {
              name: accountName(res.data),
            }),
          )
          onOpenChange(false)
        },
        onError: notifyAccountingError,
      },
    )
  }

  const doDelete = async (): Promise<void> => {
    if (!account) return
    const ok = await confirm({
      title: t('accounts.form.delete_title', { name: accountName(account) }),
      description: t('accounts.form.delete_description'),
      confirmLabel: t('common:actions.delete'),
      tone: 'danger',
    })
    if (!ok) return
    remove.mutate(
      { params: { id: account.id } },
      {
        onSuccess: (res) => {
          notify.success(
            t(
              res.data.result === 'deleted' ? 'accounts.form.deleted' : 'accounts.form.deactivated',
              {
                name: accountName(account),
              },
            ),
          )
          onOpenChange(false)
        },
        onError: notifyAccountingError,
      },
    )
  }

  const busy = create.isPending || update.isPending || remove.isPending
  const loading = editing && !account
  const showBankFields = values.type === 'asset' && values.is_bank
  const typeOptions = (canWrite ? AccountTypeSchema.options : (['expense'] as const)).map((ty) => ({
    value: ty,
    label: accountTypeLabel(ty),
  }))

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={editing ? t('accounts.form.edit_title') : t('accounts.form.new_title')}
      description={account?.is_system ? t('accounts.form.system_hint') : undefined}
      size="md"
      footer={
        <>
          {editing && account && canWrite ? (
            <div className="flex flex-wrap gap-2 sm:me-auto">
              {account.can_delete ? (
                <Button
                  variant="ghost"
                  className="text-danger"
                  leftIcon={<Trash2 />}
                  onClick={() => void doDelete()}
                  disabled={busy}
                >
                  {t('common:actions.delete')}
                </Button>
              ) : null}
              {account.is_active && account.can_deactivate ? (
                <Button
                  variant="ghost"
                  leftIcon={<Ban />}
                  onClick={() => void toggleActive()}
                  disabled={busy}
                >
                  {t('accounts.form.deactivate')}
                </Button>
              ) : null}
              {!account.is_active ? (
                <Button
                  variant="ghost"
                  leftIcon={<RotateCcw />}
                  onClick={() => void toggleActive()}
                  disabled={busy}
                >
                  {t('accounts.form.activate')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={save}
            loading={create.isPending || update.isPending}
            disabled={loading || busy}
          >
            {editing ? t('common:actions.save_changes') : t('accounts.form.create')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
          className="flex flex-col gap-4"
        >
          {account ? (
            <div className="flex flex-wrap gap-1.5">
              {account.is_system ? <Badge size="sm">{t('accounts.system')}</Badge> : null}
              {!account.is_active ? (
                <Badge tone="danger" size="sm">
                  {t('common:status.inactive')}
                </Badge>
              ) : null}
              {account.line_count > 0 ? (
                <Badge tone="info" size="sm">
                  {t('accounts.form.line_count', { count: account.line_count })}
                </Badge>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('common:fields.type')} required error={errors.type}>
              <Select<AccountType>
                value={values.type}
                onValueChange={(ty) => {
                  set('type', ty)
                  set('parent_id', null)
                }}
                options={typeOptions}
                disabled={editing || !canWrite}
              />
            </FormField>
            <FormField
              label={t('common:fields.code')}
              optional={!editing}
              error={errors.code}
              hint={
                !editing && suggested
                  ? t('accounts.form.code_hint', { code: suggested })
                  : undefined
              }
            >
              <Input
                value={values.code}
                onChange={(e) => set('code', e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder={suggested ?? ''}
                disabled={!editable.has('code')}
              />
            </FormField>
          </div>
          <FormField
            label={t('accounts.form.parent')}
            optional
            error={errors.parent_id}
            hint={t('accounts.form.parent_hint')}
          >
            <AccountPicker
              value={values.parent_id}
              onChange={(id, a) => {
                set('parent_id', id)
                if (a?.money_kind === 'bank') set('is_bank', true)
              }}
              types={[values.type]}
              excludeIds={accountId ? [accountId] : undefined}
              disabled={!editable.has('parent_id')}
            />
          </FormField>
          <FormField label={t('common:fields.name')} required error={errors.name}>
            <Input
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={120}
              autoFocus
            />
          </FormField>
          <FormField label={t('common:fields.name_ta')} optional error={errors.name_ta}>
            <Input
              value={values.name_ta}
              onChange={(e) => set('name_ta', e.target.value)}
              maxLength={120}
              lang="ta"
            />
          </FormField>
          {tenant.multiStore && (values.type === 'asset' || values.type === 'liability') ? (
            <FormField
              label={t('common:fields.store')}
              optional
              error={errors.store_id}
              hint={t('accounts.form.store_hint')}
            >
              <StorePicker
                value={values.store_id}
                onChange={(id) => set('store_id', id)}
                placeholder={t('accounts.form.all_stores')}
                disabled={!editable.has('store_id')}
              />
            </FormField>
          ) : null}
          {values.type === 'asset' ? (
            <Checkbox
              checked={values.is_bank}
              onCheckedChange={(c) => set('is_bank', c === true)}
              label={t('accounts.form.is_bank')}
              disabled={!editable.has('details')}
            />
          ) : null}
          {showBankFields ? (
            <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">
                {t('accounts.form.bank_details')}
              </legend>
              <FormField label={t('accounts.form.bank_name')} optional error={errors.bank_name}>
                <Input
                  value={values.bank_name}
                  onChange={(e) => set('bank_name', e.target.value)}
                  maxLength={100}
                />
              </FormField>
              <FormField
                label={t('accounts.form.account_last4')}
                optional
                error={errors.account_last4}
                hint={t('accounts.form.account_last4_hint')}
              >
                <Input
                  value={values.account_last4}
                  onChange={(e) =>
                    set('account_last4', e.target.value.replace(/\D/g, '').slice(0, 4))
                  }
                  inputMode="numeric"
                  maxLength={4}
                />
              </FormField>
              <FormField label="IFSC" optional error={errors.ifsc}>
                <Input
                  value={values.ifsc}
                  onChange={(e) => set('ifsc', e.target.value.toUpperCase())}
                  maxLength={11}
                />
              </FormField>
              <FormField label={t('accounts.form.branch')} optional error={errors.branch}>
                <Input
                  value={values.branch}
                  onChange={(e) => set('branch', e.target.value)}
                  maxLength={100}
                />
              </FormField>
              <FormField
                label={t('accounts.form.account_holder')}
                optional
                error={errors.account_holder}
                className="sm:col-span-2"
              >
                <Input
                  value={values.account_holder}
                  onChange={(e) => set('account_holder', e.target.value)}
                  maxLength={120}
                />
              </FormField>
            </fieldset>
          ) : null}
          {errors.form ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {errors.form}
            </p>
          ) : null}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </Dialog>
  )
}
