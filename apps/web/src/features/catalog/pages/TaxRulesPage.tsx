/**
 * Price-slab GST rules (GET /tax-slab-rules): textile / footwear rates that depend on the piece
 * price. Editor with ascending slabs (₹ limits + rate), the vertical's preset rules, and a live
 * calculator ("₹2,400 shirt → 5%, ₹2,800 → 18%") using the same maths as billing.
 */
import { type TaxSlabRule, catalogRoutes, slabRateForPrice } from '@kadai/shared/api/catalog'
import { formatBp } from '@kadai/shared/money'
import { VERTICAL_PRESETS } from '@kadai/shared/verticals'
import { Calculator, MoreVertical, Pencil, Percent, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormField,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Skeleton,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { callRoute } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { invalidateRoutes, useRouteQuery } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import { GstRateSelect } from '../components/TaxInputs'
import { slabSummary } from '../lib/format'
import { catalogReasonText, catalogValidationText, isInUseConflict } from '../lib/messages'
import {
  type RuleDraft,
  type SlabDraft,
  examplePrices,
  ruleBody,
  ruleIssues,
  toSlabs,
} from '../lib/tax-rules'

export default function TaxRulesPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const canWrite = useCan('catalog.write')
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const rules = useRouteQuery(catalogRoutes.listTaxSlabRules, { query: { limit: 200 } })
  const list = (rules.data?.data ?? []) as TaxSlabRule[]
  const [editing, setEditing] = useState<{ rule: TaxSlabRule | null; draft: RuleDraft } | null>(
    null,
  )
  const presets = (me ? VERTICAL_PRESETS[me.tenant.business_type].tax_slab_rules : []).filter(
    (p) => !list.some((r) => r.name.toLowerCase() === p.name.toLowerCase()),
  )
  const words = {
    upTo: (a: string) => t('tax_rules.up_to', { amount: a }),
    above: (a: string) => t('tax_rules.above', { amount: a }),
  }

  const refresh = (): Promise<void> =>
    invalidateRoutes(queryClient, [catalogRoutes.listTaxSlabRules])

  const remove = async (rule: TaxSlabRule): Promise<void> => {
    const ok = await confirm({
      title: t('tax_rules.delete_title', { name: rule.name }),
      description: t('tax_rules.delete_description'),
      tone: 'danger',
      confirmLabel: t('common:actions.delete'),
    })
    if (!ok) return
    try {
      await callRoute(catalogRoutes.deleteTaxSlabRule, { params: { id: rule.id } })
      notify.success(t('tax_rules.deleted', { name: rule.name }))
      await refresh()
    } catch (error) {
      if (!isInUseConflict(error)) {
        notify.error(catalogReasonText(error) ?? error)
        return
      }
      const off = await confirm({
        title: t('tax_rules.in_use_title', { name: rule.name }),
        description: t('tax_rules.in_use_description', {
          products: rule.product_count,
          categories: rule.category_count,
        }),
        confirmLabel: t('tax_rules.switch_off'),
      })
      if (!off) return
      try {
        await callRoute(catalogRoutes.updateTaxSlabRule, {
          params: { id: rule.id },
          body: { is_active: false, if_updated_at: rule.updated_at },
        })
        await refresh()
      } catch (e) {
        notify.error(e)
      }
    }
  }

  const draftOf = (rule: TaxSlabRule): RuleDraft => ({
    name: rule.name,
    description: rule.description ?? '',
    is_active: rule.is_active,
    slabs: rule.slabs.map((s) => ({ max: s.max_unit_value_paise, rate: s.gst_rate_bp })),
  })

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t('pages.tax_rules')}
        description={t('tax_rules.description')}
        actions={
          canWrite ? (
            <Button
              leftIcon={<Plus />}
              onClick={() =>
                setEditing({
                  rule: null,
                  draft: {
                    name: '',
                    description: '',
                    is_active: true,
                    slabs: [
                      { max: 250_000, rate: 500 },
                      { max: null, rate: 1800 },
                    ],
                  },
                })
              }
            >
              {t('tax_rules.add')}
            </Button>
          ) : null
        }
      />
      {canWrite && presets.length ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent-soft-foreground">
          <Sparkles className="size-4" aria-hidden />
          <span>{t('tax_rules.presets')}</span>
          {presets.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant="outline"
              onClick={() =>
                setEditing({
                  rule: null,
                  draft: {
                    name: me?.user.preferred_locale === 'ta' ? p.name_ta : p.name,
                    description: p.description,
                    is_active: true,
                    slabs: p.slabs.map((s) => ({
                      max: s.max_unit_value_paise,
                      rate: s.gst_rate_bp,
                    })),
                  },
                })
              }
            >
              {p.name}
            </Button>
          ))}
        </div>
      ) : null}
      {rules.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Percent />}
            title={t('tax_rules.empty_title')}
            description={t('tax_rules.empty_description')}
          />
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {list.map((rule) => (
            <li key={rule.id}>
              <Card className="h-full">
                <CardContent className="grid grid-cols-1 gap-3 pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold">
                        {rule.name}
                        {!rule.is_active ? (
                          <Badge tone="neutral" appearance="outline" size="sm">
                            {t('common:status.inactive')}
                          </Badge>
                        ) : null}
                      </p>
                      {rule.description ? (
                        <p className="text-sm text-muted-foreground">{rule.description}</p>
                      ) : null}
                    </div>
                    {canWrite ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            icon={<MoreVertical />}
                            label={t('tax_rules.actions_for', { name: rule.name })}
                            variant="ghost"
                            size="sm"
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            icon={<Pencil />}
                            onSelect={() => setEditing({ rule, draft: draftOf(rule) })}
                          >
                            {t('common:actions.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={<Trash2 />}
                            tone="danger"
                            onSelect={() => void remove(rule)}
                          >
                            {t('common:actions.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  <ol className="grid grid-cols-1 gap-1.5">
                    {rule.slabs.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5 text-sm"
                      >
                        <span>
                          {s.max_unit_value_paise !== null
                            ? words.upTo(formatMoney(s.max_unit_value_paise, { decimals: 'auto' }))
                            : words.above(
                                formatMoney(rule.slabs[i - 1]?.max_unit_value_paise ?? 0, {
                                  decimals: 'auto',
                                }),
                              )}
                        </span>
                        <Badge tone="primary">{formatBp(s.gst_rate_bp)}</Badge>
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {t('tax_rules.used_by', {
                      products: rule.product_count,
                      categories: rule.category_count,
                    })}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list.length ? (
        <p className="mt-4 text-xs text-muted-foreground">{t('tax_rules.how_it_works')}</p>
      ) : null}
      {editing ? (
        <RuleDialog
          rule={editing.rule}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  )
}

function RuleDialog({
  rule,
  initial,
  onClose,
  onSaved,
}: {
  rule: TaxSlabRule | null
  initial: RuleDraft
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation(['catalog', 'common'])
  const [draft, setDraft] = useState<RuleDraft>(initial)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [price, setPrice] = useState<number | null>(240_000)
  const [inclusive, setInclusive] = useState(true)
  const issues = useMemo(() => ruleIssues(draft), [draft])
  const shown = touched ? issues : {}
  const slabs =
    issues.slabs || Object.keys(issues).some((k) => k.startsWith('slabs')) ? null : toSlabs(draft)
  const examples = useMemo(() => examplePrices(draft.slabs), [draft.slabs])
  const w = {
    upTo: (a: string) => t('tax_rules.up_to', { amount: a }),
    above: (a: string) => t('tax_rules.above', { amount: a }),
  }

  const setSlab = (i: number, patch: Partial<SlabDraft>): void =>
    setDraft((d) => ({ ...d, slabs: d.slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))

  const msg = (key: string | undefined): string | undefined =>
    key ? (catalogValidationText(key) ?? key) : undefined

  const save = async (): Promise<void> => {
    setTouched(true)
    if (Object.keys(issues).length) return
    setSaving(true)
    try {
      const body = ruleBody(draft)
      if (rule)
        await callRoute(catalogRoutes.updateTaxSlabRule, {
          params: { id: rule.id },
          body: { ...body, if_updated_at: rule.updated_at },
        })
      else await callRoute(catalogRoutes.createTaxSlabRule, { body })
      notify.success(t('tax_rules.saved', { name: body.name }))
      onSaved()
      onClose()
    } catch (error) {
      const reason = catalogReasonText(error)
      if (reason) setNameError(reason)
      else notify.error(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      size="lg"
      dismissible={false}
      title={rule ? t('tax_rules.edit_title') : t('tax_rules.add_title')}
      description={t('tax_rules.editor_hint')}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('fields.name')} required error={nameError ?? msg(shown.name)}>
            <Input
              value={draft.name}
              autoFocus
              maxLength={100}
              onChange={(e) => {
                setNameError(null)
                setDraft({ ...draft, name: e.target.value })
              }}
              placeholder={t('tax_rules.name_placeholder')}
            />
          </FormField>
          <div className="flex items-end pb-2">
            <Switch
              checked={draft.is_active}
              onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
              label={t('common:status.active')}
            />
          </div>
        </div>
        <FormField label={t('fields.description')} optional>
          <Textarea
            rows={2}
            maxLength={300}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-2">
          <p className="text-sm font-semibold">{t('tax_rules.slabs')}</p>
          <ol className="grid grid-cols-1 gap-2">
            {draft.slabs.map((s, i) => {
              const last = i === draft.slabs.length - 1
              const prev = draft.slabs[i - 1]?.max ?? null
              return (
                <li
                  key={i}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_10rem_2.5rem] sm:items-start"
                >
                  {last ? (
                    <p className="pt-2 text-sm font-medium">
                      {prev === null
                        ? t('tax_rules.any_price')
                        : w.above(formatMoney(prev, { decimals: 'auto' }))}
                    </p>
                  ) : (
                    <FormField
                      label={t('tax_rules.up_to_label')}
                      error={msg(shown[`slabs.${i}.max_unit_value_paise`])}
                      hint={t('tax_rules.per_piece')}
                    >
                      <MoneyInput value={s.max} onChange={(v) => setSlab(i, { max: v })} />
                    </FormField>
                  )}
                  <FormField
                    label={t('fields.gst_rate')}
                    error={msg(shown[`slabs.${i}.gst_rate_bp`])}
                  >
                    <GstRateSelect value={s.rate} onChange={(v) => setSlab(i, { rate: v })} />
                  </FormField>
                  <div className="flex justify-end sm:pt-7">
                    {!last ? (
                      <IconButton
                        icon={<Trash2 />}
                        label={t('tax_rules.remove_slab')}
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDraft((d) => ({ ...d, slabs: d.slabs.filter((_, j) => j !== i) }))
                        }
                      />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
          {draft.slabs.length < 10 ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Plus />}
                onClick={() =>
                  setDraft((d) => {
                    const finite = d.slabs.slice(0, -1)
                    const lastMax = finite[finite.length - 1]?.max ?? 0
                    return {
                      ...d,
                      slabs: [
                        ...finite,
                        { max: lastMax + 100_000, rate: null },
                        d.slabs[d.slabs.length - 1]!,
                      ],
                    }
                  })
                }
              >
                {t('tax_rules.add_slab')}
              </Button>
            </div>
          ) : null}
          {shown.slabs ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {msg(shown.slabs)}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-info/30 bg-info-soft p-4 text-info-soft-foreground">
          <p className="flex items-center gap-2 font-semibold">
            <Calculator className="size-4" aria-hidden />
            {t('tax_rules.calculator')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
            <FormField label={t('tax_rules.piece_price')}>
              <MoneyInput value={price} onChange={setPrice} />
            </FormField>
            <Switch
              checked={inclusive}
              onCheckedChange={setInclusive}
              label={t('pricing.includes_tax')}
            />
          </div>
          {slabs ? (
            <div className="grid grid-cols-1 gap-1 text-sm" aria-live="polite">
              {price !== null ? (
                <p className="text-base font-semibold">
                  {t('tax_rules.result', {
                    price: formatMoney(price),
                    rate: formatBp(
                      slabRateForPrice(slabs, price, { price_includes_tax: inclusive }).gst_rate_bp,
                    ),
                  })}
                </p>
              ) : null}
              {examples.length ? (
                <p className="text-xs opacity-90">
                  {t('tax_rules.examples')}{' '}
                  {examples
                    .map(
                      (p) =>
                        `${formatMoney(p, { decimals: 'auto' })} → ${formatBp(slabRateForPrice(slabs, p, { price_includes_tax: inclusive }).gst_rate_bp)}`,
                    )
                    .join(', ')}
                </p>
              ) : null}
              <p className="text-xs opacity-80">{slabSummary(slabs, w)}</p>
            </div>
          ) : (
            <p className="text-sm opacity-80">{t('tax_rules.fix_slabs')}</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}
