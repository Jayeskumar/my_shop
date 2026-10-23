/**
 * GST returns (/reports/gst): pick the tax period (month) and — for businesses registered in
 * several states — the GSTIN; see GSTR-1 section by section with the warnings to fix before
 * filing, download the JSON for the GST portal / offline tool or CSV, the GSTR-3B summary in the
 * form's layout and the HSN summary. Composition dealers get their quarterly (CMP-08) summary;
 * unregistered businesses get an explanation.
 */
import {
  type CompositionSummary,
  type Gstr1Report,
  type Gstr1Section,
  type Gstr3bReport,
  GSTR1_SECTIONS,
  reportsRoutes,
} from '@kadai/shared/api/reports'
import { isPeriod } from '@kadai/shared/fy'
import { keepPreviousData } from '@tanstack/react-query'
import { CloudOff, FileJson, FileSpreadsheet, Landmark, Lock, Settings2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  RetryButton,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useMe } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { usePermission } from '@/lib/permissions'
import { downloadGstr1 } from '../api'
import { MonthPicker } from '../components/MonthPicker'
import { CompositionView } from '../gst/CompositionView'
import { GstWarningsPanel } from '../gst/GstWarningsPanel'
import { HsnTable } from '../gst/Gstr1SectionTable'
import { Gstr1View } from '../gst/Gstr1View'
import { Gstr3bView } from '../gst/Gstr3bView'
import { useReportCalendar } from '../lib/calendar'
import { defaultGstPeriod, periodOfToday, sectionSummary } from '../lib/gst'
import { useLang } from '../lib/labels'
import { periodLabel } from '../lib/periods'

const TABS = ['gstr1', 'gstr3b', 'hsn'] as const
type Tab = (typeof TABS)[number]

type Header = Gstr1Report | Gstr3bReport | CompositionSummary

function needsAllStores(error: unknown): boolean {
  return isApiError(error) && error.details?.reason === 'all_stores_required'
}

function isNotRegistered(error: unknown): boolean {
  return isApiError(error) && error.details?.reason === 'gst_not_registered'
}

export default function GstReturnsPage() {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const me = useMe()
  const cal = useReportCalendar()
  const confirm = useConfirm()
  const canDownload = usePermission('reports.gst')
  const [params, setParams] = useSearchParams()
  const maxPeriod = periodOfToday(cal)
  const urlPeriod = params.get('period')
  const period =
    urlPeriod && isPeriod(urlPeriod) && urlPeriod <= maxPeriod ? urlPeriod : defaultGstPeriod(cal)
  const urlTab = params.get('tab')
  const tab: Tab = (TABS as readonly string[]).includes(urlTab ?? '') ? (urlTab as Tab) : 'gstr1'
  const gstin = params.get('gstin') ?? undefined
  const [section, setSection] = useState<Gstr1Section>('b2b')
  const [hsnSupply, setHsnSupply] = useState<'b2b' | 'b2c'>('b2c')
  const [busy, setBusy] = useState<string | null>(null)

  const scheme = me?.tenant.gst_scheme ?? 'regular'
  const setParam = (key: string, value: string | null): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === null) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  }

  const query = { period, ...(gstin ? { gstin } : {}) }
  const gstr1 = useRouteQuery(
    reportsRoutes.gstr1,
    { query },
    {
      enabled: scheme !== 'unregistered' && (tab !== 'gstr3b' || scheme === 'composition'),
      placeholderData: keepPreviousData,
      meta: { errorToast: false },
    },
  )
  const gstr3b = useRouteQuery(
    reportsRoutes.gstr3b,
    { query },
    {
      enabled: scheme === 'regular' && tab === 'gstr3b',
      placeholderData: keepPreviousData,
      meta: { errorToast: false },
    },
  )
  const active = tab === 'gstr3b' && scheme === 'regular' ? gstr3b : gstr1
  const data = active.data?.data ?? null

  // A GSTIN from an old link that is not (or no longer) a registration: back to the default.
  useEffect(() => {
    const err = active.error
    if (gstin && isApiError(err) && err.status === 404) {
      notify.warning(t('reports:gst.gstin_not_found'))
      setParam('gstin', null)
    }
    // setParam is recreated each render; the effect reacts to the error only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.error, gstin])

  const unregistered =
    scheme === 'unregistered' || data?.kind === 'unregistered' || isNotRegistered(active.error)
  const header: Header | null = data && data.kind !== 'unregistered' ? data : null
  const gstr1Report = gstr1.data?.data.kind === 'gstr1' ? gstr1.data.data : null
  const composition = data?.kind === 'composition' ? data : null

  const download = async (format: 'json' | 'csv', sectionKey?: Gstr1Section): Promise<void> => {
    if (!gstr1Report) return
    const errors = gstr1Report.warnings.filter((w) => w.severity === 'error').length
    if (format === 'json' && errors > 0) {
      const ok = await confirm({
        title: t('reports:gst.download_with_errors_title'),
        description: t('reports:gst.download_with_errors', { count: errors }),
        confirmLabel: t('reports:gst.download_anyway'),
        tone: 'primary',
      })
      if (!ok) return
    }
    setBusy(sectionKey ? `csv-${sectionKey}` : format)
    try {
      const name = await downloadGstr1({
        period,
        gstin: gstr1Report.gstin,
        format,
        ...(sectionKey ? { section: sectionKey } : {}),
        ...(gstin ? { selectedGstin: gstin } : {}),
      })
      notify.success(t('reports:gst.downloaded', { name }))
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(null)
    }
  }

  const periodPicker = (
    <MonthPicker
      label={t('reports:gst.period')}
      value={period}
      max={maxPeriod}
      onChange={(p) => setParam('period', p === defaultGstPeriod(cal) ? null : p)}
    />
  )

  const gstinPicker =
    header && header.gstins.length > 1 ? (
      <Select
        aria-label={t('reports:gst.gstin')}
        value={gstin ?? header.gstin}
        onValueChange={(v) => setParam('gstin', v)}
        options={header.gstins.map((g) => ({
          value: g.gstin,
          label: g.gstin,
          description: g.store_names.join(', '),
        }))}
        className="sm:w-64"
      />
    ) : null

  const downloads =
    canDownload && scheme === 'regular' && tab === 'gstr1' ? (
      <>
        <Button
          variant="primary"
          leftIcon={<FileJson />}
          loading={busy === 'json'}
          disabled={!gstr1Report}
          onClick={() => void download('json')}
        >
          {t('reports:gst.download_json')}
        </Button>
        <Button
          variant="outline"
          leftIcon={<FileSpreadsheet />}
          loading={busy === 'csv'}
          disabled={!gstr1Report}
          onClick={() => void download('csv')}
        >
          {t('reports:gst.download_csv')}
        </Button>
      </>
    ) : null

  let body: ReactNode
  if (unregistered) {
    body = (
      <EmptyState
        icon={<Landmark />}
        title={t('reports:gst.unregistered_title')}
        description={t('reports:gst.unregistered_hint')}
        action={
          <Button asChild variant="outline" leftIcon={<Settings2 />}>
            <Link to="/settings/business">{t('reports:gst.business_settings')}</Link>
          </Button>
        }
      />
    )
  } else if (needsAllStores(active.error)) {
    body = (
      <EmptyState
        icon={<Lock />}
        title={t('reports:gst.all_stores_title')}
        description={t('reports:gst.all_stores_hint')}
      />
    )
  } else if (active.error && !data) {
    const d = describeError(active.error)
    body = (
      <EmptyState
        icon={<CloudOff />}
        title={d.title}
        description={d.description}
        action={<RetryButton onRetry={() => void active.refetch()} />}
      />
    )
  } else if (!header) {
    body = <GstSkeleton />
  } else if (composition) {
    body = (
      <div className="grid grid-cols-1 gap-4">
        <GstWarningsPanel warnings={composition.warnings} />
        <CompositionView report={composition} />
      </div>
    )
  } else {
    body = (
      <Tabs value={tab} onValueChange={(v) => setParam('tab', v === 'gstr1' ? null : v)}>
        <TabsList aria-label={t('reports:gst.returns')}>
          <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
          <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
          <TabsTrigger value="hsn">{t('reports:gst.hsn_tab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="gstr1" className="grid grid-cols-1 gap-4">
          {gstr1Report ? (
            <>
              <GstWarningsPanel warnings={gstr1Report.warnings} />
              <Gstr1View
                report={gstr1Report}
                section={section}
                onSectionChange={setSection}
                onSectionCsv={(s) => void download('csv', s)}
                csvBusy={busy === `csv-${section}`}
                canDownload={canDownload}
              />
            </>
          ) : (
            <GstSkeleton />
          )}
        </TabsContent>
        <TabsContent value="gstr3b" className="grid grid-cols-1 gap-4">
          {data?.kind === 'gstr3b' ? (
            <>
              <GstWarningsPanel warnings={data.warnings} />
              <Gstr3bView report={data} />
            </>
          ) : (
            <GstSkeleton />
          )}
        </TabsContent>
        <TabsContent value="hsn" className="grid grid-cols-1 gap-3">
          {gstr1Report ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs
                  value={hsnSupply}
                  onValueChange={(v) => setHsnSupply(v === 'b2b' ? 'b2b' : 'b2c')}
                  variant="pills"
                >
                  <TabsList aria-label={t('reports:gst.hsn_tab')}>
                    <TabsTrigger value="b2c">{t('reports:gst.sections.hsn_b2c')}</TabsTrigger>
                    <TabsTrigger value="b2b">{t('reports:gst.sections.hsn_b2b')}</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button asChild variant="link">
                  <Link to="/reports/hsn-summary">{t('reports:gst.hsn_custom_range')}</Link>
                </Button>
              </div>
              <HsnTable
                label={t(`reports:gst.sections.hsn_${hsnSupply}`)}
                rows={hsnSupply === 'b2b' ? gstr1Report.hsn.b2b : gstr1Report.hsn.b2c}
                totalsFrom={sectionSummary(gstr1Report, `hsn_${hsnSupply}`)}
              />
            </>
          ) : (
            <GstSkeleton />
          )}
        </TabsContent>
      </Tabs>
    )
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title={t('reports:gst.title')}
        description={
          scheme === 'composition'
            ? t('reports:gst.description_composition')
            : t('reports:gst.description')
        }
        breadcrumbs={[
          { label: t('reports:index.title'), to: '/reports' },
          { label: t('reports:gst.title') },
        ]}
        actions={downloads}
      />
      {!unregistered ? (
        <Card className="mb-4 flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            {periodPicker}
            {gstinPicker}
          </div>
          {header ? (
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr] lg:text-end">
              <dt className="text-muted-foreground">{t('reports:gst.gstin')}</dt>
              <dd className="font-mono font-semibold tracking-wide">{header.gstin}</dd>
              <dt className="text-muted-foreground">{t('reports:gst.business')}</dt>
              <dd className="font-medium">
                {header.legal_name && header.legal_name !== header.trade_name
                  ? `${header.legal_name} (${header.trade_name})`
                  : header.trade_name}
              </dd>
              <dt className="text-muted-foreground">{t('reports:gst.return_period')}</dt>
              <dd>
                {periodLabel(header.period, lng)}{' '}
                <Badge size="sm" className="ms-1 font-mono">
                  {header.fp}
                </Badge>
              </dd>
              <dt className="sr-only">{t('reports:gst.generated')}</dt>
              <dd className="text-xs text-muted-foreground sm:col-span-2">
                {t('reports:gst.generated_at', { at: formatDateTime(header.generated_at) })}
                {active.isFetching ? ` · ${t('common:misc.loading')}` : ''}
              </dd>
            </dl>
          ) : (
            <Skeleton className="h-16 w-full max-w-sm" />
          )}
        </Card>
      ) : null}
      {body}
    </div>
  )
}

function GstSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden>
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {GSTR1_SECTIONS.slice(0, 5).map((s) => (
          <Skeleton key={s} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
