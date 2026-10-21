/**
 * Product import: 1) download the template of the shop's vertical, 2) upload a CSV
 * (POST /files?purpose=import), 3) dry run (POST /products/import, dry_run true) with the
 * per-row errors and a preview, 4) import. Large files run as a job: progress is polled from
 * GET /imports/:id until it completes.
 */
import {
  type ProductImportColumnDef,
  catalogRoutes,
  productImportColumns,
} from '@kadai/shared/api/catalog'
import {
  FILE_UPLOAD_RULES,
  IMPORT_INLINE_MAX_ROWS,
  type ImportJob,
} from '@kadai/shared/api/identity'
import { newId } from '@kadai/shared/ids'
import { useQuery } from '@tanstack/react-query'
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  ListChecks,
  RotateCcw,
  Upload,
  XCircle,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  PageHeader,
  RadioGroup,
  Select,
  Spinner,
  notify,
} from '@/components/ui'
import { callRoute, downloadRoute } from '@/lib/api'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { invalidateRoutes } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import { LinkButton } from '../components/LinkButton'
import { uploadFile, uploadIssue } from '../lib/files'
import { firstIssueText, importDetailText, importErrorText } from '../lib/messages'

type MatchBy = 'sku' | 'barcode' | 'sku_or_barcode'
type Mode = 'upsert' | 'create_only'

const POLL_MS = 1500

function isRunning(job: ImportJob | null): boolean {
  return (
    job !== null &&
    (job.status === 'pending' || job.status === 'validating' || job.status === 'processing')
  )
}

export default function ImportPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const queryClient = useQueryClient()
  const businessType = me?.tenant.business_type ?? 'other'
  const columns = productImportColumns(businessType)
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [mode, setMode] = useState<Mode>('upsert')
  const [matchBy, setMatchBy] = useState<MatchBy>('sku_or_barcode')
  const [createCategories, setCreateCategories] = useState(true)
  const [createBrands, setCreateBrands] = useState(true)
  const [busy, setBusy] = useState<'dry' | 'import' | null>(null)
  const [job, setJob] = useState<ImportJob | null>(null)

  // Job-based imports (> IMPORT_INLINE_MAX_ROWS rows): poll until finished.
  const poll = useQuery({
    queryKey: ['catalog', 'import', job?.id],
    queryFn: ({ signal }) =>
      callRoute(catalogRoutes.getImport, { params: { id: job!.id }, signal }),
    enabled: isRunning(job),
    refetchInterval: POLL_MS,
  })
  const polled = poll.data?.data
  const current = polled && polled.id === job?.id ? polled : job
  useEffect(() => {
    if (!polled || !job || polled.id !== job.id || isRunning(polled)) return
    // finished: keep the final state and refresh the lists
    setJob(polled)
    if (!polled.dry_run && polled.status === 'completed') {
      notify.success(t('import.done', { count: polled.success_rows }))
      void invalidateRoutes(queryClient, [
        catalogRoutes.listProducts,
        catalogRoutes.listCategories,
        catalogRoutes.listBrands,
      ])
    }
  }, [polled, job, queryClient, t])

  const downloadTemplate = (): void => {
    void notify.promise(
      downloadRoute(catalogRoutes.productImportTemplate, {
        query: { business_type: businessType },
        filename: `kadai-products-${businessType}.csv`,
      }),
      { loading: t('import.downloading'), success: t('import.downloaded') },
    )
  }

  const pick = async (f: File): Promise<void> => {
    // The product import reads CSV only (Excel: "Save as → CSV UTF-8"); refuse a sheet early.
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      notify.error(t('import_errors.import_format'))
      return
    }
    const issue = uploadIssue('import', f)
    if (issue) {
      notify.error(t(`files.${issue}`, { max: FILE_UPLOAD_RULES.import.max_bytes / 1024 / 1024 }))
      return
    }
    setUploading(true)
    setJob(null)
    try {
      const meta = await uploadFile(f, 'import')
      setFile({ id: meta.id, name: meta.filename })
      await run(true, meta.id)
    } catch (error) {
      notify.error(error)
    } finally {
      setUploading(false)
    }
  }

  const run = async (dryRun: boolean, fileId = file?.id): Promise<void> => {
    if (!fileId) return
    setBusy(dryRun ? 'dry' : 'import')
    try {
      const res = await callRoute(catalogRoutes.importProducts, {
        body: {
          file_id: fileId,
          mode,
          dry_run: dryRun,
          match_by: matchBy,
          create_categories: createCategories,
          create_brands: createBrands,
        },
        // The real import is idempotent per file + options (a double click imports once); every
        // dry run is a fresh check.
        idempotencyKey: dryRun
          ? newId()
          : `${fileId}:${mode}:${matchBy}:${createCategories}:${createBrands}`,
      })
      setJob(res.data)
      if (!dryRun && res.data.status === 'completed') {
        notify.success(t('import.done', { count: res.data.success_rows }))
        await invalidateRoutes(queryClient, [
          catalogRoutes.listProducts,
          catalogRoutes.listCategories,
          catalogRoutes.listBrands,
        ])
      }
    } catch (error) {
      notify.error(firstIssueText(error) ?? error)
    } finally {
      setBusy(null)
    }
  }

  const reset = (): void => {
    setFile(null)
    setJob(null)
  }

  const step = !file ? 2 : !current || current.dry_run ? 3 : 4

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t('pages.import')}
        description={t('import.description')}
        breadcrumbs={[
          { label: t('pages.products'), to: '/catalog/products' },
          { label: t('pages.import') },
        ]}
      />
      <ol className="grid grid-cols-1 gap-4">
        <StepCard
          n={1}
          active={false}
          done
          title={t('import.step_template')}
          description={t('import.step_template_hint')}
        >
          <div className="grid grid-cols-1 gap-4">
            <div>
              <Button variant="outline" leftIcon={<Download />} onClick={downloadTemplate}>
                {t('import.download_template')}
              </Button>
            </div>
            <ColumnsTable columns={columns} />
          </div>
        </StepCard>

        <StepCard
          n={2}
          active={step === 2}
          done={Boolean(file)}
          title={t('import.step_upload')}
          description={t('import.step_upload_hint', { rows: formatNumber(IMPORT_INLINE_MAX_ROWS) })}
        >
          <div className="grid grid-cols-1 gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid grid-cols-1 gap-1.5">
                <p className="text-sm font-medium">{t('import.mode')}</p>
                <RadioGroup
                  value={mode}
                  onValueChange={(v) => {
                    setMode(v)
                    setJob(null)
                  }}
                  options={[
                    {
                      value: 'upsert',
                      label: t('import.mode_upsert'),
                      description: t('import.mode_upsert_hint'),
                    },
                    {
                      value: 'create_only',
                      label: t('import.mode_create'),
                      description: t('import.mode_create_hint'),
                    },
                  ]}
                />
              </div>
              <div className="grid grid-cols-1 content-start gap-3">
                <label className="grid grid-cols-1 gap-1.5 text-sm font-medium">
                  {t('import.match_by')}
                  <Select<MatchBy>
                    value={matchBy}
                    onValueChange={(v) => {
                      setMatchBy(v)
                      setJob(null)
                    }}
                    options={[
                      { value: 'sku_or_barcode', label: t('import.match_sku_or_barcode') },
                      { value: 'sku', label: t('import.match_sku') },
                      { value: 'barcode', label: t('import.match_barcode') },
                    ]}
                  />
                </label>
                <Checkbox
                  checked={createCategories}
                  onCheckedChange={(v) => setCreateCategories(v === true)}
                  label={t('import.create_categories')}
                />
                <Checkbox
                  checked={createBrands}
                  onCheckedChange={(v) => setCreateBrands(v === true)}
                  label={t('import.create_brands')}
                />
              </div>
            </div>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label={t('import.choose_file')}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void pick(f)
              }}
            />
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) void pick(f)
              }}
              disabled={uploading || busy !== null}
              className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-surface-2/50 px-4 py-6 text-center transition-colors hover:border-primary hover:bg-primary-soft/30 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              {uploading ? (
                <Spinner label={t('import.uploading')} />
              ) : (
                <FileUp className="size-8 text-primary" aria-hidden />
              )}
              <span className="font-medium">{file ? file.name : t('import.drop')}</span>
              <span className="text-xs text-muted-foreground">{t('import.drop_hint')}</span>
            </button>
          </div>
        </StepCard>

        <StepCard
          n={3}
          active={step === 3}
          done={step === 4}
          title={t('import.step_check')}
          description={t('import.step_check_hint')}
        >
          {current ? (
            <JobResult job={current} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('import.check_waiting')}</p>
          )}
          {file && current?.dry_run && !isRunning(current) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="lg"
                leftIcon={<Upload />}
                onClick={() => void run(false)}
                loading={busy === 'import'}
                disabled={current.success_rows === 0 && current.total_rows > 0}
              >
                {current.error_rows
                  ? t('import.import_valid', { count: current.success_rows })
                  : t('import.import_all', { count: current.success_rows })}
              </Button>
              <Button
                variant="outline"
                leftIcon={<RotateCcw />}
                onClick={() => void run(true)}
                loading={busy === 'dry'}
              >
                {t('import.recheck')}
              </Button>
              <Button variant="ghost" onClick={reset}>
                {t('import.another_file')}
              </Button>
            </div>
          ) : null}
        </StepCard>

        {current && !current.dry_run ? (
          <StepCard
            n={4}
            active
            done={current.status === 'completed'}
            title={t('import.step_import')}
          >
            <div className="grid grid-cols-1 gap-4">
              <JobResult job={current} />
              {!isRunning(current) ? (
                <div className="flex flex-wrap gap-2">
                  <LinkButton to="/catalog/products" icon={<ListChecks />}>
                    {t('import.view_products')}
                  </LinkButton>
                  <Button variant="outline" onClick={reset}>
                    {t('import.another_file')}
                  </Button>
                </div>
              ) : null}
            </div>
          </StepCard>
        ) : null}
      </ol>
    </div>
  )
}

function StepCard({
  n,
  title,
  description,
  active,
  done,
  children,
}: {
  n: number
  title: string
  description?: string
  active: boolean
  done: boolean
  children: ReactNode
}) {
  return (
    <li>
      <Card className={cn(active && 'border-primary/50 ring-2 ring-primary/15')}>
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold',
              done
                ? 'bg-success text-success-foreground'
                : active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-2 text-muted-foreground',
            )}
            aria-hidden
          >
            {done ? <CheckCircle2 className="size-4" /> : n}
          </span>
          <div className="grid grid-cols-1 gap-1">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </li>
  )
}

function ColumnsTable({ columns }: { columns: readonly ProductImportColumnDef[] }) {
  const { t } = useTranslation('catalog')
  const lng = getLanguage()
  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
        <FileSpreadsheet className="size-4" aria-hidden />
        {t('import.columns', { count: columns.length })}
      </summary>
      <div className="max-h-80 overflow-auto border-t border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start">{t('import.col_column')}</th>
              <th className="px-3 py-2 text-start">{t('import.col_meaning')}</th>
              <th className="px-3 py-2 text-start">{t('import.col_example')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.key} className="border-t border-border">
                <td className="px-3 py-1.5 font-mono text-xs">
                  {c.key}
                  {c.required ? <span className="ms-1 text-danger">*</span> : null}
                </td>
                <td className="px-3 py-1.5">
                  {lng === 'ta' ? c.description_ta : c.description_en}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                  {c.example || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function JobResult({ job }: { job: ImportJob }) {
  const { t } = useTranslation('catalog')
  const running = isRunning(job)
  const s = job.summary
  return (
    <div className="grid grid-cols-1 gap-4">
      {running ? (
        <div className="grid grid-cols-1 gap-2" aria-live="polite">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Spinner size="sm" label="" />
            {job.dry_run ? t('import.checking') : t('import.importing')}{' '}
            {Math.floor(job.progress_bp / 100)}%
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(job.progress_bp / 100)}
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${job.progress_bp / 100}%` }}
            />
          </div>
        </div>
      ) : job.status === 'failed' ? (
        <p className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
          <XCircle className="size-4" aria-hidden />
          {t('import.failed')}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Count label={t('import.total')} value={job.total_rows} />
        <Count
          label={job.dry_run ? t('import.will_create') : t('import.created')}
          value={s.created}
          tone="success"
        />
        <Count
          label={job.dry_run ? t('import.will_update') : t('import.updated')}
          value={s.updated}
          tone="info"
        />
        <Count label={t('import.unchanged')} value={s.unchanged + s.skipped} />
        <Count
          label={t('import.errors')}
          value={job.error_rows}
          tone={job.error_rows ? 'danger' : undefined}
        />
      </dl>
      {Object.values(s.details).some((v) => v > 0) ? (
        <p className="text-xs text-muted-foreground">
          {Object.entries(s.details)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => importDetailText(k, v))
            .join(' · ')}
        </p>
      ) : null}
      {job.errors.length ? (
        <div className="grid grid-cols-1 gap-2">
          <p className="text-sm font-semibold text-danger">
            {t('import.error_rows', { count: job.error_rows })}
            {job.errors_truncated ? ` ${t('import.errors_truncated')}` : ''}
          </p>
          <div className="max-h-80 overflow-auto rounded-lg border border-danger/30">
            <table className="w-full text-sm" aria-label={t('import.errors')}>
              <thead className="sticky top-0 bg-danger-soft text-xs uppercase text-danger-soft-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">{t('import.col_row')}</th>
                  <th className="px-3 py-2 text-start">{t('import.col_column')}</th>
                  <th className="px-3 py-2 text-start">{t('import.col_problem')}</th>
                </tr>
              </thead>
              <tbody>
                {job.errors.map((e, i) => (
                  <tr key={`${e.row}-${e.field}-${i}`} className="border-t border-border">
                    <td className="px-3 py-1.5 tabular-nums">
                      {e.row === 0 ? t('import.whole_file') : e.row}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{e.field ?? '—'}</td>
                    <td className="px-3 py-1.5">{importErrorText(e.code, e.message)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {job.preview.length ? (
        <div className="grid grid-cols-1 gap-2">
          <p className="text-sm font-semibold">{t('import.preview')}</p>
          <div className="max-h-72 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm" aria-label={t('import.preview')}>
              <thead className="sticky top-0 bg-surface-2 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">{t('import.col_row')}</th>
                  <th className="px-3 py-2 text-start">{t('import.col_action')}</th>
                  <th className="px-3 py-2 text-start">{t('import.col_key')}</th>
                  <th className="px-3 py-2 text-start">{t('fields.name')}</th>
                </tr>
              </thead>
              <tbody>
                {job.preview.map((p) => (
                  <tr key={p.row} className="border-t border-border">
                    <td className="px-3 py-1.5 tabular-nums">{p.row}</td>
                    <td className="px-3 py-1.5">
                      <Badge
                        size="sm"
                        tone={
                          p.action === 'create'
                            ? 'success'
                            : p.action === 'update'
                              ? 'info'
                              : p.action === 'error'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {t(`import.action_${p.action}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{p.key ?? '—'}</td>
                    <td className="px-3 py-1.5">{p.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Count({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'success' | 'info' | 'danger'
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'success' && 'border-success/30 bg-success-soft text-success-soft-foreground',
        tone === 'info' && 'border-info/30 bg-info-soft text-info-soft-foreground',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger-soft-foreground',
        !tone && 'border-border bg-surface-2',
      )}
    >
      <dt className="text-xs font-medium opacity-80">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{formatNumber(value)}</dd>
    </div>
  )
}
