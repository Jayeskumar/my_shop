/**
 * Platform plans & editions (/platform/plans, cloud mode, platformAdmin):
 *  - View all cloud SaaS plans and on-prem server editions
 *  - Edit a plan's name, pricing, and public visibility (PUT /platform/plans/:code)
 */
import { type PlanAdmin, licensingRoutes } from '@kadai/shared/api/licensing'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  Money,
  MoneyInput,
  PageHeader,
  Skeleton,
  Switch,
  notify,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

export default function PlatformPlansPage() {
  const { t } = useTranslation(['platform', 'common'])
  const listQuery = useRouteQuery(licensingRoutes.listPlans, {})
  const updateMutation = useRouteMutation(licensingRoutes.updatePlan, {
    invalidates: [licensingRoutes.listPlans],
  })

  const [editing, setEditing] = useState<PlanAdmin | null>(null)
  const [name, setName] = useState('')
  const [nameTa, setNameTa] = useState('')
  const [description, setDescription] = useState('')
  const [monthlyPaise, setMonthlyPaise] = useState<number | null>(0)
  const [yearlyPaise, setYearlyPaise] = useState<number | null>(0)
  const [isPublic, setIsPublic] = useState(true)

  const plans = listQuery.data?.data ?? []

  const openEditor = (p: PlanAdmin) => {
    setEditing(p)
    setName(p.name)
    setNameTa(p.name_ta ?? '')
    setDescription(p.description ?? '')
    setMonthlyPaise(p.price_monthly_paise)
    setYearlyPaise(p.price_yearly_paise)
    setIsPublic(p.is_public)
  }

  const handleSave = async () => {
    if (!editing || !name.trim()) return
    try {
      await updateMutation.mutateAsync({
        params: { code: editing.code },
        body: {
          name: name.trim(),
          name_ta: nameTa.trim() || null,
          description: description.trim() || null,
          price_monthly_paise: monthlyPaise ?? 0,
          price_yearly_paise: yearlyPaise ?? 0,
          limits: editing.limits,
          features: editing.features,
          is_public: isPublic,
          sort_order: editing.sort_order,
        },
      })
      setEditing(null)
      notify.success(t('plans.edit_dialog.saved_toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  return (
    <div className="grid gap-6 pb-8">
      <PageHeader
        title={t('plans.title')}
        description={t('plans.description')}
      />

      {listQuery.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : listQuery.error && !listQuery.data ? (
        <EmptyState
          title={t('plans.load_error')}
          description={describeError(listQuery.error).title}
          action={
            <Button variant="outline" onClick={() => void listQuery.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.code} className="flex flex-col justify-between">
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={p.channel === 'onprem' ? 'accent' : 'info'} size="sm">
                      {p.channel === 'onprem'
                        ? t('plans.channel_onprem')
                        : t('plans.channel_cloud')}
                    </Badge>
                    <Badge tone={p.is_public ? 'success' : 'neutral'} size="sm">
                      {p.is_public ? t('plans.public') : t('plans.private')}
                    </Badge>
                  </div>
                  <CardTitle className="mt-2 text-lg">
                    {localizedName(p.name, p.name_ta)}
                  </CardTitle>
                  <p className="font-mono text-xs text-muted-foreground">{p.code}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Pencil className="size-4" />}
                  onClick={() => openEditor(p)}
                >
                  {t('plans.edit')}
                </Button>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {p.description ? (
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                ) : null}
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2/60 p-2.5 text-xs">
                  <div>
                    <div className="text-muted-foreground">{t('plans.monthly')}</div>
                    <div className="font-semibold">
                      <Money paise={p.price_monthly_paise} decimals={0} />
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('plans.yearly')}</div>
                    <div className="font-semibold">
                      <Money paise={p.price_yearly_paise} decimals={0} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{t('plans.features_count', { count: p.features.length })}</span>
                  <span>
                    {p.channel === 'onprem'
                      ? t('plans.licenses_using', { count: formatNumber(p.licenses_count) })
                      : t('plans.tenants_using', { count: formatNumber(p.tenants_count) })}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        title={t('plans.edit_dialog.title', { code: editing?.code ?? '' })}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              loading={updateMutation.isPending}
              disabled={!name.trim()}
              onClick={() => void handleSave()}
            >
              {t('plans.edit_dialog.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="plan-name-en" className="text-sm font-medium">
              {t('plans.edit_dialog.name')}
            </label>
            <Input
              id="plan-name-en"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="plan-name-ta" className="text-sm font-medium">
              {t('plans.edit_dialog.name_ta')}
            </label>
            <Input
              id="plan-name-ta"
              value={nameTa}
              onChange={(e) => setNameTa(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="plan-desc" className="text-sm font-medium">
              {t('plans.edit_dialog.description')}
            </label>
            <Input
              id="plan-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="plan-monthly" className="text-sm font-medium">
                {t('plans.edit_dialog.monthly_price')}
              </label>
              <MoneyInput
                id="plan-monthly"
                value={monthlyPaise}
                onChange={setMonthlyPaise}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="plan-yearly" className="text-sm font-medium">
                {t('plans.edit_dialog.yearly_price')}
              </label>
              <MoneyInput
                id="plan-yearly"
                value={yearlyPaise}
                onChange={setYearlyPaise}
              />
            </div>
          </div>
          <Switch
            checked={isPublic}
            onCheckedChange={setIsPublic}
            label={t('plans.edit_dialog.public_label')}
          />
        </div>
      </Dialog>
    </div>
  )
}
