/**
 * Customer import (old khata book / Excel → Kadai): download the template, pick a CSV, check it
 * with a dry run (counts, per-row problems, preview), then import. Rows with problems are skipped
 * and listed so the shopkeeper can fix them in the sheet and import again (upsert by mobile).
 */
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  RotateCcw,
} from 'lucide-react'
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import {
  type ImportError,
  type ImportJob,
  IMPORT_INLINE_MAX_ROWS,
} from '@kadai/shared/api/identity'
import { CUSTOMER_IMPORT_COLUMNS, partiesRoutes } from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import {
  Badge,
  Button,
  Dialog,
  RadioGroup,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  notify,
} from '@/components/ui'
import { downloadRoute, isApiError } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { cn } from '@/lib/cn'
import { useImportCustomers } from '../api'
import { langOf } from '../lib/labels'
import { uploadFile } from '../lib/upload'
import { useValidationKeyText } from '../lib/validation-text'

const MAX_FILE_BYTES = 10 * 1024 * 1024
type MatchBy = 'phone' | 'code'
type Mode = 'upsert' | 'create_only'

export function CustomerImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!open) return null
  return <ImportBody onOpenChange={onOpenChange} />
}

function ImportBody({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [matchBy, setMatchBy] = useState<MatchBy>('phone')
  const [mode, setMode] = useState<Mode>('upsert')
  const [fileId, setFileId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dryRun, setDryRun] = useState<ImportJob | null>(null)
  const [result, setResult] = useState<ImportJob | null>(null)
  const [showColumns, setShowColumns] = useState(false)
  const importKey = useRef(newId())
  const run = useImportCustomers()
  const keyText = useValidationKeyText()
  const lang = langOf(i18n.language)

  // A large file can still be processing as a job: poll until it finishes.
  const pending =
    result &&
    (result.status === 'pending' ||
      result.status === 'validating' ||
      result.status === 'processing')
  const poll = useRouteQuery(
    catalogRoutes.getImport,
    { params: { id: result?.id ?? '00000000-0000-7000-8000-000000000000' } },
    { enabled: Boolean(pending), refetchInterval: 2_000 },
  )
  const finalResult = pending && poll.data ? poll.data.data : result

  const pickFile = (f: File | null | undefined): void => {
    setDryRun(null)
    setResult(null)
    setFileId(null)
    setFileError(null)
    if (!f) {
      setFile(null)
      return
    }
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      setFile(null)
      setFileError(t('import.only_csv'))
      return
    }
    if (f.size === 0 || f.size > MAX_FILE_BYTES) {
      setFile(null)
      setFileError(f.size === 0 ? t('import.file_empty') : t('import.file_too_large'))
      return
    }
    setFile(f)
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>): void => {
    e.preventDefault()
    pickFile(e.dataTransfer.files[0])
  }

  const check = async (): Promise<void> => {
    if (!file) return
    try {
      setUploading(true)
      let id = fileId
      if (!id) {
        const uploaded = await uploadFile(file, 'import')
        id = uploaded.data.id
        setFileId(id)
      }
      const res = await run.mutateAsync({
        body: { file_id: id, dry_run: true, mode, match_by: matchBy },
      })
      setDryRun(res.data)
      importKey.current = newId()
    } catch (error) {
      // File-level problems (not a CSV, too many rows, missing columns) come back as a
      // VALIDATION_ERROR on `file_id`; show them next to the file picker.
      const issue = isApiError(error)
        ? error.validationIssues.find((i) => i.path === 'file_id' || i.path === '')
        : undefined
      const text = issue ? keyText(issue.message) : undefined
      if (text) {
        setFileError(text)
        setFileId(null)
      } else notify.error(error)
    } finally {
      setUploading(false)
    }
  }

  const commit = (): void => {
    if (!fileId) return
    run.mutate(
      {
        body: { file_id: fileId, dry_run: false, mode, match_by: matchBy },
        idempotencyKey: importKey.current,
      },
      {
        onSuccess: (res) => {
          setResult(res.data)
          if (res.data.status === 'completed')
            notify.success(
              t('import.done_toast', {
                count: res.data.summary.created + res.data.summary.updated,
              }),
            )
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  const reset = (): void => {
    pickFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const busy = uploading || run.isPending
  const job = finalResult ?? dryRun
  const writable = dryRun ? dryRun.summary.created + dryRun.summary.updated : 0

  const footer = finalResult ? (
    <Button onClick={() => onOpenChange(false)} disabled={Boolean(pending)}>
      {t('common:actions.done')}
    </Button>
  ) : dryRun ? (
    <>
      <Button variant="outline" leftIcon={<RotateCcw />} onClick={reset} disabled={busy}>
        {t('import.choose_another')}
      </Button>
      <Button onClick={commit} loading={run.isPending} disabled={writable === 0}>
        {t('import.import_n', { count: writable })}
      </Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
        {t('common:actions.cancel')}
      </Button>
      <Button onClick={() => void check()} loading={busy} disabled={!file}>
        {t('import.check_file')}
      </Button>
    </>
  )

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o)
      }}
      title={t('import.title')}
      description={t('import.description', { max: formatNumber(IMPORT_INLINE_MAX_ROWS) })}
      size="lg"
      dismissible={!busy && !dryRun}
      footer={footer}
    >
      {!dryRun && !finalResult ? (
        <div className="grid gap-5">
          <ol className="grid gap-3 text-sm sm:grid-cols-3">
            {(['step_template', 'step_fill', 'step_upload'] as const).map((key, i) => (
              <li key={key} className="flex items-start gap-2 rounded-lg bg-surface-2 p-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <span>{t(`import.${key}`)}</span>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              leftIcon={<Download />}
              onClick={() =>
                void downloadRoute(partiesRoutes.customerImportTemplate, {
                  filename: 'kadai-customers-template.csv',
                }).catch((e: unknown) => notify.error(e))
              }
            >
              {t('import.download_template')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowColumns((v) => !v)}>
              {showColumns ? t('import.hide_columns') : t('import.show_columns')}
            </Button>
          </div>

          {showColumns ? (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('import.column')}</TableHead>
                    <TableHead>{t('import.meaning')}</TableHead>
                    <TableHead>{t('import.example')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CUSTOMER_IMPORT_COLUMNS.map((c) => (
                    <TableRow key={c.key}>
                      <TableCell className="py-1.5 font-mono text-xs">
                        {c.key}
                        {c.required ? <span className="text-danger"> *</span> : null}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs">
                        {lang === 'ta' ? c.description_ta : c.description_en}
                      </TableCell>
                      <TableCell className="py-1.5 font-mono text-xs text-muted-foreground">
                        {c.example}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          <label
            htmlFor={inputId}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
              file ? 'border-primary bg-primary-soft/40' : 'border-border hover:border-primary/60',
              fileError && 'border-danger',
            )}
          >
            {file ? (
              <FileSpreadsheet className="size-8 text-primary" aria-hidden />
            ) : (
              <FileUp className="size-8 text-muted-foreground" aria-hidden />
            )}
            <span className="font-medium">{file ? file.name : t('import.drop_here')}</span>
            <span className="text-xs text-muted-foreground">
              {file ? t('import.change_file') : t('import.file_hint')}
            </span>
            <input
              id={inputId}
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e: ChangeEvent<HTMLInputElement>) => pickFile(e.target.files?.[0])}
            />
          </label>
          {fileError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {fileError}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('import.match_by')}</span>
              <RadioGroup<MatchBy>
                value={matchBy}
                onValueChange={setMatchBy}
                options={[
                  { value: 'phone', label: t('import.match_phone') },
                  { value: 'code', label: t('import.match_code') },
                ]}
                aria-label={t('import.match_by')}
              />
            </div>
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('import.mode')}</span>
              <RadioGroup<Mode>
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: 'upsert', label: t('import.mode_upsert') },
                  { value: 'create_only', label: t('import.mode_create_only') },
                ]}
                aria-label={t('import.mode')}
              />
            </div>
          </div>
        </div>
      ) : job ? (
        <ImportReport job={job} committed={Boolean(finalResult)} pending={Boolean(pending)} />
      ) : null}
    </Dialog>
  )
}

function ImportReport({
  job,
  committed,
  pending,
}: {
  job: ImportJob
  committed: boolean
  pending: boolean
}) {
  const { t } = useTranslation('parties')
  const s = job.summary
  const stats = [
    { key: 'created' as const, value: s.created, tone: 'success' as const },
    { key: 'updated' as const, value: s.updated, tone: 'info' as const },
    { key: 'unchanged' as const, value: s.unchanged, tone: 'neutral' as const },
    { key: 'errors' as const, value: job.error_rows, tone: 'danger' as const },
  ]
  return (
    <div className="grid gap-4">
      {pending ? (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 p-3 text-sm">
          <Spinner label="" />
          {t('import.processing', { pct: Math.round(job.progress_bp / 100) })}
        </div>
      ) : job.status === 'failed' ? (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('import.failed')}
        </div>
      ) : (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg p-3 text-sm',
            job.error_rows > 0
              ? 'bg-warning-soft text-warning-soft-foreground'
              : 'bg-success-soft text-success-soft-foreground',
          )}
        >
          {job.error_rows > 0 ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span>
            {committed
              ? t('import.committed_summary', { count: s.created + s.updated })
              : job.error_rows > 0
                ? t('import.dry_run_with_errors', { count: job.error_rows })
                : t('import.dry_run_ok', { count: job.total_rows })}
          </span>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.key} className="rounded-lg border border-border p-3">
            <dt className="text-xs text-muted-foreground">
              {t(committed ? `import.stat_${stat.key}_done` : `import.stat_${stat.key}`)}
            </dt>
            <dd className="text-xl font-bold tabular-nums">
              <Badge tone={stat.tone} className="text-base">
                {formatNumber(stat.value)}
              </Badge>
            </dd>
          </div>
        ))}
      </dl>

      {job.errors.length > 0 ? (
        <ImportErrors errors={job.errors} truncated={job.errors_truncated} />
      ) : null}

      {!committed && job.preview.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">{t('import.preview')}</h3>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('import.row')}</TableHead>
                  <TableHead>{t('import.action')}</TableHead>
                  <TableHead>{t('fields.name')}</TableHead>
                  <TableHead>{t('import.key')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.preview.map((p) => (
                  <TableRow key={p.row}>
                    <TableCell className="py-1.5 tabular-nums">{p.row}</TableCell>
                    <TableCell className="py-1.5">
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
                        {t(`import.actions.${p.action}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5">{p.name ?? '—'}</TableCell>
                    <TableCell className="py-1.5 font-mono text-xs">{p.key ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ImportErrors({ errors, truncated }: { errors: ImportError[]; truncated: boolean }) {
  const { t } = useTranslation('parties')
  const keyText = useValidationKeyText()
  // Row codes are validation keys (CUSTOMER_IMPORT_ERROR_CODES); unknown ones show the detail.
  const describe = (e: ImportError): string => keyText(e.code) ?? e.message
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold text-danger">{t('import.problems')}</h3>
      <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('import.row')}</TableHead>
              <TableHead>{t('import.column')}</TableHead>
              <TableHead>{t('import.problem')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errors.map((e, i) => (
              <TableRow key={`${e.row}-${e.field ?? ''}-${i}`}>
                <TableCell className="py-1.5 tabular-nums">
                  {e.row === 0 ? t('import.whole_file') : e.row}
                </TableCell>
                <TableCell className="py-1.5 font-mono text-xs">{e.field ?? '—'}</TableCell>
                <TableCell className="py-1.5 text-sm">{describe(e)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {truncated ? (
        <p className="text-xs text-muted-foreground">{t('import.more_errors')}</p>
      ) : null}
    </div>
  )
}
