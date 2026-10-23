/**
 * Edit a batch (PATCH /batches/:id): MRP and prices (inventory.adjust or catalog.write), expiry
 * and manufacturing dates (inventory.adjust only), active flag. Only changed fields are sent,
 * with `if_updated_at` so two people editing the same batch do not overwrite each other.
 */
import {
  type BatchRow,
  type BatchUpdate,
  BatchUpdateSchema,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DatePicker, Dialog, FormField, MoneyInput, Switch, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { invalidateRoutes, useRouteMutation } from '@/lib/query'
import { useInventoryAccess } from '../lib/access'
import { notifyInventoryError, validationText } from '../lib/errors'
import { productNames } from '../lib/labels'

interface Draft {
  mrp_paise: number | null
  sale_price_paise: number | null
  purchase_price_paise: number | null
  expiry_date: string | null
  mfg_date: string | null
  is_active: boolean
}

function draftOf(b: BatchRow): Draft {
  return {
    mrp_paise: b.mrp_paise,
    sale_price_paise: b.sale_price_paise,
    purchase_price_paise: b.purchase_price_paise,
    expiry_date: b.expiry_date,
    mfg_date: b.mfg_date,
    is_active: b.is_active,
  }
}

export function BatchEditDialog({
  batch,
  onOpenChange,
}: {
  batch: BatchRow | null
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const access = useInventoryAccess()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(batch ? draftOf(batch) : null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(batch ? draftOf(batch) : null)
    setError(null)
  }, [batch])

  const save = useRouteMutation(inventoryRoutes.updateBatch, {
    invalidates: [inventoryRoutes.listBatches, inventoryRoutes.listStock],
    onError: (e) => {
      if (isApiError(e) && e.code === 'STALE_WRITE') {
        void invalidateRoutes(queryClient, [inventoryRoutes.listBatches])
        notify.warning(t('batches.stale'))
        onOpenChange(false)
        return
      }
      notifyInventoryError(e)
    },
    onSuccess: () => {
      notify.success(t('batches.saved'))
      onOpenChange(false)
    },
  })

  if (!batch || !draft) return null
  const names = productNames(batch.product_name, batch.product_name_ta, i18n.language)

  const submit = (): void => {
    const before = draftOf(batch)
    const body: BatchUpdate = { if_updated_at: batch.updated_at }
    if (access.editBatchPrices) {
      if (draft.mrp_paise !== before.mrp_paise) body.mrp_paise = draft.mrp_paise
      if (draft.sale_price_paise !== before.sale_price_paise)
        body.sale_price_paise = draft.sale_price_paise
      if (draft.purchase_price_paise !== before.purchase_price_paise)
        body.purchase_price_paise = draft.purchase_price_paise
    }
    if (access.adjust) {
      if (draft.expiry_date !== before.expiry_date) body.expiry_date = draft.expiry_date
      if (draft.mfg_date !== before.mfg_date) body.mfg_date = draft.mfg_date
      if (draft.is_active !== before.is_active) body.is_active = draft.is_active
    }
    // Date order is checked on the resulting values, not only the changed ones.
    if (draft.mfg_date && draft.expiry_date && draft.mfg_date > draft.expiry_date) {
      setError(validationText('batch_dates') ?? null)
      return
    }
    const parsed = BatchUpdateSchema.safeParse(body)
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message
      if (message === 'empty_patch') {
        onOpenChange(false)
        return
      }
      setError(validationText(message) ?? message ?? null)
      return
    }
    save.mutate({ params: { id: batch.id }, body })
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="md"
      title={t('batches.edit_title', { batch: batch.batch_no })}
      description={names.primary}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {t('common:actions.save_changes')}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label={t('batches.mrp')}>
            <MoneyInput
              value={draft.mrp_paise}
              disabled={!access.editBatchPrices}
              onChange={(v) => setDraft({ ...draft, mrp_paise: v })}
            />
          </FormField>
          <FormField label={t('batches.sale_price')}>
            <MoneyInput
              value={draft.sale_price_paise}
              disabled={!access.editBatchPrices}
              onChange={(v) => setDraft({ ...draft, sale_price_paise: v })}
            />
          </FormField>
          <FormField label={t('batches.purchase_price')}>
            <MoneyInput
              value={draft.purchase_price_paise}
              disabled={!access.editBatchPrices}
              onChange={(v) => setDraft({ ...draft, purchase_price_paise: v })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            label={t('batches.expiry_date')}
            hint={access.adjust ? undefined : t('batches.dates_need_adjust')}
            error={error}
          >
            <DatePicker
              value={draft.expiry_date}
              disabled={!access.adjust}
              onChange={(v) => {
                setError(null)
                setDraft({ ...draft, expiry_date: v })
              }}
            />
          </FormField>
          <FormField label={t('batches.mfg_date')}>
            <DatePicker
              value={draft.mfg_date}
              disabled={!access.adjust}
              onChange={(v) => {
                setError(null)
                setDraft({ ...draft, mfg_date: v })
              }}
            />
          </FormField>
        </div>
        {access.adjust ? (
          <Switch
            checked={draft.is_active}
            onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
            label={t('batches.active')}
            description={t('batches.active_hint')}
          />
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
