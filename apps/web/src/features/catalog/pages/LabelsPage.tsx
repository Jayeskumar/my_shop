/**
 * Barcode labels (POST /labels, feature barcode_labels): pick products / variants (search or
 * scan — scanning the same item again adds a copy), batches for batch-tracked items, copies,
 * template (38×25 / 50×25 mm roll, A4 65-up), what to print; preview in an iframe with the exact
 * page CSS and print through lib/print.
 */
import {
  LABEL_TEMPLATES,
  type LabelPrintModel,
  type LabelTemplateCode,
  MAX_LABEL_COPIES,
  type ProductListItem,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import {
  AlertTriangle,
  Barcode,
  Eye,
  Minus,
  Plus,
  Printer,
  ScanBarcode,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { BatchPicker, ProductPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  IconButton,
  Money,
  NumberInput,
  PageHeader,
  RadioGroup,
  notify,
} from '@/components/ui'
import { callRoute } from '@/lib/api'
import { useCan, useCurrentStore } from '@/lib/auth'
import { getLanguage, localizedName } from '@/lib/i18n'
import { buildPrintDocument, printHtml } from '@/lib/print'
import { storage } from '@/lib/storage'
import { useRouteMutation } from '@/lib/query'
import { bilingual } from '../lib/format'
import { type LabelNameMode, labelCss, renderLabelsHtml, sheetCount } from '../lib/labels'
import { firstIssueText } from '../lib/messages'

interface LabelRow {
  key: string
  product: ProductListItem
  batch_id: string | null
  copies: number
}

const TEMPLATE_CODES = Object.keys(LABEL_TEMPLATES) as LabelTemplateCode[]

const LABEL_PREFS_KEY = 'catalog.label_prefs'

interface LabelPrefs {
  template: LabelTemplateCode
  nameMode: LabelNameMode
  showShop: boolean
  showMrp: boolean
  showPrice: boolean
}

function isLabelPrefs(v: unknown): v is LabelPrefs {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    TEMPLATE_CODES.includes(p.template as LabelTemplateCode) &&
    (p.nameMode === 'both' || p.nameMode === 'en' || p.nameMode === 'ta') &&
    typeof p.showShop === 'boolean' &&
    typeof p.showMrp === 'boolean' &&
    typeof p.showPrice === 'boolean'
  )
}

function loadLabelPrefs(): LabelPrefs {
  return storage.get<LabelPrefs>(
    LABEL_PREFS_KEY,
    {
      template: '50x25',
      nameMode: getLanguage() === 'ta' ? 'both' : 'en',
      showShop: true,
      showMrp: true,
      showPrice: true,
    },
    isLabelPrefs,
  )
}

export default function LabelsPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const store = useCurrentStore()
  const canWrite = useCan('catalog.write')
  const [params] = useSearchParams()
  const [rows, setRows] = useState<LabelRow[]>([])
  // The label printer and layout rarely change: remembered per device.
  const [saved] = useState(() => loadLabelPrefs())
  const [template, setTemplate] = useState<LabelTemplateCode>(saved.template)
  const [nameMode, setNameMode] = useState<LabelNameMode>(saved.nameMode)
  const [showShop, setShowShop] = useState(saved.showShop)
  const [showMrp, setShowMrp] = useState(saved.showMrp)
  const [showPrice, setShowPrice] = useState(saved.showPrice)
  useEffect(() => {
    storage.set(LABEL_PREFS_KEY, {
      template,
      nameMode,
      showShop,
      showMrp,
      showPrice,
    } satisfies LabelPrefs)
  }, [template, nameMode, showShop, showMrp, showPrice])
  const [generate, setGenerate] = useState(false)
  const [model, setModel] = useState<LabelPrintModel | null>(null)
  const [prefilling, setPrefilling] = useState(false)
  const prefilled = useRef(false)

  const totalCopies = rows.reduce((n, r) => n + r.copies, 0)
  const overLimit = totalCopies > MAX_LABEL_COPIES

  // Prefill from ?product_ids=a,b (products list selection, product page); parents → variants.
  useEffect(() => {
    if (prefilled.current) return
    const ids = (params.get('product_ids') ?? '').split(',').filter(Boolean).slice(0, 200)
    if (!ids.length) return
    prefilled.current = true
    setPrefilling(true)
    void (async () => {
      try {
        const res = await callRoute(catalogRoutes.listProducts, {
          query: { ids, limit: 200, ...(store ? { store_id: store.id } : {}) },
        })
        const found: ProductListItem[] = []
        for (const p of res.data) {
          if (p.kind !== 'variant_parent') {
            found.push(p)
            continue
          }
          const kids = await callRoute(catalogRoutes.listProducts, {
            query: {
              parent_id: p.id,
              limit: 200,
              is_active: true,
              ...(store ? { store_id: store.id } : {}),
            },
          })
          found.push(...kids.data)
        }
        setRows(found.map((p) => ({ key: p.id, product: p, batch_id: null, copies: 1 })))
      } catch (error) {
        notify.error(error)
      } finally {
        setPrefilling(false)
      }
    })()
  }, [params, store])

  const add = (p: ProductListItem | null): void => {
    if (!p) return
    setModel(null)
    setRows((list) => {
      const existing = list.find((r) => r.product.id === p.id && r.batch_id === null)
      if (existing) return list.map((r) => (r === existing ? { ...r, copies: r.copies + 1 } : r))
      return [...list, { key: `${p.id}:${Date.now()}`, product: p, batch_id: null, copies: 1 }]
    })
  }

  const patch = (key: string, change: Partial<LabelRow>): void => {
    setModel(null)
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)))
  }

  const labels = useRouteMutation(catalogRoutes.printLabels, {
    onError: (error) => notify.error(firstIssueText(error) ?? error),
  })

  const words = {
    mrp: t('labels.word_mrp'),
    price: t('labels.word_price'),
    batch: t('labels.word_batch'),
    expiry: t('labels.word_expiry'),
  }
  const opts = { showShop, showMrp, showPrice, nameMode, words }

  const fetchModel = async (): Promise<LabelPrintModel | null> => {
    if (!rows.length || overLimit) return null
    const res = await labels.mutateAsync({
      body: {
        template,
        items: rows.map((r) => ({
          product_id: r.product.id,
          batch_id: r.batch_id,
          copies: r.copies,
        })),
        ...(store ? { store_id: store.id } : {}),
        generate_missing_barcodes: canWrite && generate,
      },
    })
    setModel(res.data)
    return res.data
  }

  const preview = async (): Promise<void> => {
    try {
      await fetchModel()
    } catch {
      // toasted in onError
    }
  }

  const print = async (): Promise<void> => {
    try {
      const m = model ?? (await fetchModel())
      if (!m) return
      await printHtml(renderLabelsHtml(m, opts), {
        paper: 'a4',
        css: labelCss(m),
        title: t('labels.print_title'),
      })
    } catch (error) {
      if (!labels.isError) notify.error(error)
    }
  }

  const missing = model?.labels.filter((l) => !l.barcode).length ?? 0

  return (
    <div>
      <PageHeader title={t('pages.labels')} description={t('labels.description')} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ScanBarcode className="size-4" aria-hidden />
                {t('labels.items')}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3">
              <ProductPicker
                value={null}
                onChange={add}
                size="lg"
                placeholder={t('labels.add_placeholder')}
                aria-label={t('labels.add_placeholder')}
              />
              {rows.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Barcode />}
                  title={prefilling ? t('common:misc.loading') : t('labels.empty_title')}
                  description={t('labels.empty_description')}
                />
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {rows.map((r) => {
                    const p = r.product
                    const variant = Object.values(p.variant_attributes).join(' / ')
                    return (
                      <li
                        key={r.key}
                        className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span className="truncate">{localizedName(p.name, p.name_ta)}</span>
                            {variant && !p.name.includes(variant) ? (
                              <Badge size="sm">{variant}</Badge>
                            ) : null}
                          </p>
                          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">
                              {p.primary_barcode ?? t('labels.no_barcode')}
                            </span>
                            <Money paise={p.sale_price_paise} />
                          </p>
                          {p.track_batches ? (
                            <div className="mt-2 max-w-sm">
                              <BatchPicker
                                productId={p.id}
                                value={r.batch_id}
                                onChange={(id) => patch(r.key, { batch_id: id })}
                                size="sm"
                                placeholder={t('labels.pick_batch')}
                                aria-label={t('labels.pick_batch')}
                              />
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1">
                          <IconButton
                            icon={<Minus />}
                            label={t('labels.fewer')}
                            variant="outline"
                            size="sm"
                            onClick={() => patch(r.key, { copies: Math.max(1, r.copies - 1) })}
                          />
                          <NumberInput
                            value={r.copies}
                            onChange={(n) => patch(r.key, { copies: Math.max(1, n ?? 1) })}
                            min={1}
                            max={MAX_LABEL_COPIES}
                            size="sm"
                            className="w-16 text-center"
                            aria-label={t('labels.copies_of', { name: p.name })}
                          />
                          <IconButton
                            icon={<Plus />}
                            label={t('labels.more')}
                            variant="outline"
                            size="sm"
                            onClick={() => patch(r.key, { copies: r.copies + 1 })}
                          />
                          <IconButton
                            icon={<Trash2 />}
                            label={t('common:actions.remove')}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setModel(null)
                              setRows((list) => list.filter((x) => x.key !== r.key))
                            }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {rows.length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span
                    className={overLimit ? 'font-semibold text-danger' : 'text-muted-foreground'}
                  >
                    {t('labels.total', { count: totalCopies })}
                    {overLimit ? ` — ${t('validation.label_copies_limit')}` : ''}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setRows([])}>
                    {t('labels.clear')}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
          {model ? <LabelPreview model={model} html={renderLabelsHtml(model, opts)} /> : null}
        </div>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('labels.template')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4">
              <RadioGroup
                value={template}
                onValueChange={(v) => {
                  setTemplate(v)
                  setModel(null)
                }}
                variant="cards"
                options={TEMPLATE_CODES.map((code) => ({
                  value: code,
                  label: bilingual({
                    en: LABEL_TEMPLATES[code].name_en,
                    ta: LABEL_TEMPLATES[code].name_ta,
                  }),
                  description: t(`labels.template_hint_${LABEL_TEMPLATES[code].media}`),
                }))}
              />
              <div className="grid grid-cols-1 gap-2">
                <p className="text-sm font-medium">{t('labels.name_language')}</p>
                <RadioGroup
                  value={nameMode}
                  onValueChange={setNameMode}
                  orientation="horizontal"
                  className="flex flex-wrap gap-x-5 gap-y-2"
                  options={[
                    { value: 'both', label: t('labels.name_both') },
                    { value: 'ta', label: t('labels.name_ta') },
                    { value: 'en', label: t('labels.name_en') },
                  ]}
                />
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                <Checkbox
                  checked={showShop}
                  onCheckedChange={(v) => setShowShop(v === true)}
                  label={t('labels.show_shop')}
                />
                <Checkbox
                  checked={showMrp}
                  onCheckedChange={(v) => setShowMrp(v === true)}
                  label={t('labels.show_mrp')}
                />
                <Checkbox
                  checked={showPrice}
                  onCheckedChange={(v) => setShowPrice(v === true)}
                  label={t('labels.show_price')}
                />
                {canWrite ? (
                  <Checkbox
                    checked={generate}
                    onCheckedChange={(v) => {
                      setGenerate(v === true)
                      setModel(null)
                    }}
                    label={t('labels.generate_missing')}
                    description={t('labels.generate_missing_hint')}
                  />
                ) : null}
              </div>
            </CardContent>
          </Card>
          <div className="sticky bottom-[5.75rem] z-10 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2 rounded-xl border border-border bg-surface/95 p-2 shadow-raised backdrop-blur md:bottom-4 lg:static lg:grid-cols-1 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
            <Button
              variant="outline"
              size="lg"
              leftIcon={<Eye />}
              onClick={() => void preview()}
              disabled={!rows.length || overLimit}
              loading={labels.isPending && !model}
            >
              {t('labels.preview')}
            </Button>
            <Button
              size="lg"
              leftIcon={<Printer />}
              onClick={() => void print()}
              disabled={!rows.length || overLimit}
              loading={labels.isPending}
            >
              {t('labels.print', { count: totalCopies })}
            </Button>
          </div>
          {missing > 0 ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('labels.missing_barcodes', { count: missing })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function LabelPreview({ model, html }: { model: LabelPrintModel; html: string }) {
  const { t } = useTranslation('catalog')
  const roll = model.template.media === 'roll'
  // Show the first sheets only (large print runs); roll labels enlarged to be readable.
  const sheets = Math.min(sheetCount(model), roll ? 12 : 1)
  const zoom = roll ? 1.6 : 0.75
  const heightMm = (model.template.page_height_mm + 4) * sheets * zoom
  const doc = useMemo(
    () =>
      buildPrintDocument(html, {
        paper: 'a4',
        css: `${labelCss(model)}
html { background: #e5e7eb; zoom: ${zoom}; }
body { margin: 0 auto !important; }
.sheet { background: #fff; margin: 0 0 4mm; box-shadow: 0 1px 3px rgba(0,0,0,.25); }`,
      }),
    [html, model, zoom],
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('labels.preview_title', { count: model.total_copies })}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-surface-2 p-3">
          <iframe
            title={t('labels.preview_title', { count: model.total_copies })}
            srcDoc={doc}
            className="mx-auto block border-0"
            style={{
              width: `${(model.template.page_width_mm + 2) * zoom}mm`,
              height: `${heightMm}mm`,
            }}
            sandbox="allow-same-origin"
          />
        </div>
      </CardContent>
    </Card>
  )
}
