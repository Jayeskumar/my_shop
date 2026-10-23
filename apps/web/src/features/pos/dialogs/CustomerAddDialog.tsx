/**
 * Quick add of a customer from the counter (parties contract POST /customers): mobile number and
 * name (Tamil name optional) — enough for khata, loyalty and WhatsApp bills. A number that
 * already exists picks that customer instead (409 DUPLICATE → lookup).
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import { Button, Dialog, FormField, Input, notify } from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { validationToken } from '@/lib/validation'
import { customerFromRow } from '../lib/convert'
import { usePos } from '../state/pos-context'

const FormSchema = z.object({
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || normalizeIndianPhone(v) !== null, {
      message: validationToken('phone'),
    }),
  name: z.string().trim().min(1).max(200),
  name_ta: z.string().trim().max(200),
})
type FormValues = z.infer<typeof FormSchema>

export function CustomerAddDialog({
  draft,
  onClose,
}: {
  draft: { name?: string; phone?: string }
  onClose: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const [saving, setSaving] = useState(false)
  const key = useMemo(() => newId(), [])
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      phone: draft.phone ? draft.phone.replace(/^\+91/, '') : '',
      name: draft.name ?? '',
      name_ta: '',
    },
  })

  const onSubmit = form.handleSubmit(async (v) => {
    setSaving(true)
    const phone = v.phone ? normalizeIndianPhone(v.phone) : null
    try {
      const res = await callRoute(partiesRoutes.createCustomer, {
        body: { name: v.name, name_ta: v.name_ta || null, phone },
        idempotencyKey: key,
      })
      pos.setCustomer(customerFromRow(res.data))
      notify.success(t('customer.added', { name: res.data.name }))
      onClose()
      pos.focusSearch()
    } catch (e) {
      if (isApiError(e) && e.code === 'DUPLICATE' && phone) {
        try {
          const found = await callRoute(partiesRoutes.lookupCustomer, { query: { phone } })
          pos.setCustomer(customerFromRow(found.data))
          notify.info(t('customer.existing', { name: found.data.name }))
          onClose()
          return
        } catch {
          // fall through to the generic error
        }
      }
      if (!applyServerFieldErrors(e, form.setError, ['phone', 'name', 'name_ta'])) notify.error(e)
    } finally {
      setSaving(false)
    }
  })

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('customer.add_title')}
      size="sm"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('customer.cancel')}
          </Button>
          <Button type="submit" form="pos-customer-add" loading={saving}>
            {t('customer.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id="pos-customer-add" onSubmit={onSubmit} className="grid gap-4 pb-2" noValidate>
          <FormField name="phone" label={t('customer.phone')}>
            <Input
              {...form.register('phone')}
              inputMode="tel"
              autoComplete="off"
              startAdornment="+91"
              autoFocus={!draft.phone}
            />
          </FormField>
          <FormField name="name" label={t('customer.name')} required>
            <Input {...form.register('name')} autoComplete="off" autoFocus={Boolean(draft.phone)} />
          </FormField>
          <FormField name="name_ta" label={t('customer.name_ta')} optional>
            <Input {...form.register('name_ta')} autoComplete="off" lang="ta" />
          </FormField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
