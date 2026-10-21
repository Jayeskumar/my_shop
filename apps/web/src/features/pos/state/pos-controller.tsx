/**
 * The billing counter's controller: one provider owns the register scope, the offline catalogue,
 * the cart, live pricing, the outbox, the customer display and every counter action (scan, add,
 * hold / recall, estimate, checkout online → offline fallback, printing). Screens and dialogs
 * read it with usePos().
 */
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Feature } from '@kadai/shared/features'
import { hasPermission, type Permission } from '@kadai/shared/permissions'
import { todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import {
  type InvoiceSaveResult,
  type SalesPrintModel,
  lineRequiresRx,
  salesRoutes,
} from '@kadai/shared/api/sales'
import type { PromotionLike } from '@kadai/shared/promotions'
import { notify } from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { useAuth, useMe } from '@/lib/auth'
import { getLanguage } from '@/lib/i18n'
import { heldCarts, meta } from '@/lib/offline/db'
import { useOnline } from '@/lib/online'
import { invalidateRoutes } from '@/lib/query'
import { beepError, beepOk } from '../lib/beep'
import {
  type CartCustomer,
  type CartState,
  allowsDecimalQty,
  defaultQtyMilli,
  emptyCart,
} from '../lib/cart'
import { getProducts, getPromotions, lineExtras, lookupCode, posMetaKeys } from '../lib/catalog'
import { recalledLines, sellableToPosProduct } from '../lib/convert'
import { issuesOfError } from '../lib/issues'
import { isSilentPrinting } from '../lib/kiosk'
import { type PricingEnv, linePrice, priceLocalCart, quoteDiff } from '../lib/pricing'
import {
  type CartScope,
  estimateBody,
  heldCreateBody,
  heldUpdateBody,
  invoiceCreateBody,
  quoteRequest,
  syncInvoiceBody,
} from '../lib/requests'
import { advanceSeriesPast, queueOfflineDocument } from '../lib/series'
import { isOfflineError } from '../lib/sync'
import { type PosTender, summarizeTenders, toTenderInputs } from '../lib/tenders'
import { type PosProduct, type PosRegisterScope, registerScopeKey } from '../lib/types'
import { buildOfflinePrintModel } from '../print/offline-model'
import {
  type AddOptions,
  type CompleteOptions,
  type CompletedSale,
  type PosApi,
  type PosDialog,
  type PosPermissions,
  PosCtx,
  type SaleOutcome,
} from './pos-context'
import { printSalesDocument, printSalesModel } from '../print/render'
import { usePosCatalog } from '../hooks/use-pos-catalog'
import { useCart } from '../hooks/use-cart'
import { useOutbox } from '../hooks/use-outbox'
import { useCustomerDisplay } from '../hooks/use-customer-display'
import { useScale } from '../hardware/use-scale'

type LastPrint = { kind: 'server'; id: string } | { kind: 'model'; model: SalesPrintModel }

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function PosProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('pos')
  const queryClient = useQueryClient()
  const me = useMe()
  const permissions = useAuth((s) => s.permissions)
  const storeId = useAuth((s) => s.selection.storeId)
  const registerId = useAuth((s) => s.selection.registerId)
  const { online } = useOnline()

  const tenantId = me?.tenant.id ?? null
  const scope = useMemo<PosRegisterScope | null>(
    () =>
      tenantId && storeId
        ? { tenantId, storeId, registerId, key: registerScopeKey(storeId, registerId) }
        : null,
    [tenantId, storeId, registerId],
  )

  const catalog = usePosCatalog(scope)
  const context = catalog.context
  const { cart, dispatch, restored } = useCart(scope)
  const outbox = useOutbox(scope, true)
  const [dialog, setDialog] = useState<PosDialog | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastSale, setLastSale] = useState<CompletedSale | null>(null)
  const [promotions, setPromotions] = useState<PromotionLike[]>([])
  const [displayPaused, setDisplayPaused] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const customerRef = useRef<HTMLInputElement | null>(null)
  const rxPromptedFor = useRef<string | null>(null)
  const cartRef = useRef(cart)
  useEffect(() => {
    cartRef.current = cart
  })

  const can = useCallback(
    (p: Permission | readonly Permission[]) => hasPermission(permissions, p),
    [permissions],
  )
  const features = useMemo(
    () => new Set<Feature>(context?.features ?? me?.entitlements.features ?? []),
    [context, me],
  )
  const hasFeature = useCallback((f: Feature) => features.has(f), [features])

  const perms = useMemo<PosPermissions>(
    () => ({
      priceOverride: can('sales.price_override'),
      discountOverride: can('sales.discount_override'),
      credit: can('sales.credit'),
      collect: can('payments.collect'),
      customersRead: can('customers.read'),
      customersWrite: can('customers.write'),
      catalogRead: can('catalog.read'),
      createSales: can('sales.create'),
      returns: can('sales.return'),
      shiftsOperate: can('shifts.operate'),
      editPrice: can('sales.price_override') || context?.settings.pos.allow_price_edit === true,
    }),
    [can, context],
  )

  const timezone = context?.tenant.timezone ?? me?.tenant.timezone ?? 'Asia/Kolkata'
  const today = todayIn(timezone)

  // Promotions from the cache (feature promotions), re-read after every catalogue sync.
  useEffect(() => {
    if (!scope || !context || !context.features.includes('promotions')) {
      setPromotions([])
      return
    }
    let cancelled = false
    void getPromotions(scope.tenantId, context.store.id).then((p) => {
      if (!cancelled) setPromotions(p)
    })
    return () => {
      cancelled = true
    }
  }, [scope, context, catalog.revision])

  // Fresh product snapshots for the lines in the cart after a catalogue sync.
  useEffect(() => {
    if (!scope || !context || catalog.revision === 0) return
    const lines = cartRef.current.lines
    if (lines.length === 0) return
    let cancelled = false
    void (async () => {
      const products = await getProducts(
        scope.tenantId,
        lines.map((l) => l.product.id),
      )
      const map = new Map<
        string,
        {
          product: PosProduct
          store_price: CartState['lines'][number]['store_price']
          tax_slabs: CartState['lines'][number]['tax_slabs']
        }
      >()
      for (const p of products) {
        const extras = await lineExtras(scope.tenantId, context, p, today)
        map.set(p.id, { product: p, store_price: extras.store_price, tax_slabs: extras.tax_slabs })
      }
      if (!cancelled && map.size) dispatch({ type: 'refresh_products', products: map })
    })()
    return () => {
      cancelled = true
    }
    // Only after a sync (revision), not on every cart change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.revision])

  const pricingEnv = useMemo<PricingEnv | null>(
    () =>
      context
        ? {
            tax_mode: context.tax_mode,
            round_off: context.settings.invoice.round_off,
            store_id: context.store.id,
            timezone,
            promotions,
            loyalty: context.features.includes('loyalty') ? context.settings.loyalty : null,
          }
        : null,
    [context, timezone, promotions],
  )

  const pricing = useMemo(
    () =>
      pricingEnv
        ? priceLocalCart(cart, pricingEnv)
        : priceLocalCart(
            { ...cart, lines: [] },
            {
              tax_mode: 'regular',
              round_off: 'none',
              store_id: '',
              timezone,
              promotions: [],
              loyalty: null,
            },
          ),
    [cart, pricingEnv, timezone],
  )

  const rxNeeded = useMemo(() => {
    if (!context || cart.rx) return false
    const schedules = context.settings.pharmacy.require_rx_for_schedules
    return cart.lines.some((l) => lineRequiresRx(l.product.attributes, schedules))
  }, [cart, context])

  // Register setting (default off); nothing is broadcast before the counter context is known.
  const displayEnabled = context?.register?.settings.customer_display === true
  const branding = useMemo(
    () =>
      context
        ? {
            store_name: context.tenant.name,
            store_name_ta: context.tenant.name_ta,
            logo_url: context.tenant.logo_url?.startsWith('data:') ? context.tenant.logo_url : null,
          }
        : null,
    [context],
  )
  const display = useCustomerDisplay({
    enabled: displayEnabled,
    branding,
    cart,
    pricing,
    paused: displayPaused,
  })

  const scale = useScale(
    context?.register?.settings.scale ?? null,
    context?.register?.id ?? scope?.key ?? 'counter',
  )

  const displayApi = useMemo(
    () => ({
      send: display.send,
      enabled: displayEnabled,
      paused: displayPaused,
      setPaused: setDisplayPaused,
    }),
    [display.send, displayEnabled, displayPaused],
  )

  const silentPrint = isSilentPrinting(context?.register?.settings.silent_print === true)
  const autoPrint = context?.register ? context.register.settings.auto_print : true
  const sound = context?.settings.pos.sound ?? true

  const openDialog = useCallback((d: PosDialog) => setDialog(d), [])
  const closeDialog = useCallback(() => setDialog(null), [])
  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])

  const cartScope = useCallback((): CartScope | null => {
    if (!scope) return null
    return { store_id: scope.storeId, register_id: scope.registerId }
  }, [scope])

  // ---- adding products ------------------------------------------------------------------------

  const addProduct = useCallback(
    async (product: PosProduct, options: AddOptions = {}): Promise<void> => {
      if (!scope || !context) return
      setLastSale(null)
      if (product.kind === 'variant_parent') {
        setDialog({ name: 'variants', parent: product, options })
        return
      }
      if (!product.is_active) {
        beepError(sound)
        notify.error(t('errors.product_inactive', { name: product.name }))
        return
      }
      const extras = await lineExtras(scope.tenantId, context, product, today)
      let batch = options.batch ?? extras.batch
      const auto = !options.batch
      if (product.track_batches && !batch && extras.batches.length > 0) {
        // Every cached batch is expired.
        if (context.settings.inventory.block_expired_sale) {
          beepError(sound)
          notify.error(t('errors.all_batches_expired', { name: product.name }))
          return
        }
        batch = extras.batches[0] ?? null
      }
      let qty = options.qty_milli ?? null
      if (qty === null && options.price_paise != null) {
        const unit = linePrice(
          {
            key: '',
            product,
            qty_milli: 1000,
            batch,
            batch_auto: auto,
            store_price: extras.store_price,
            tax_slabs: extras.tax_slabs,
            price_override_paise: null,
            discount_bp: 0,
            discount_paise: 0,
            serial_numbers: [],
            scanned_code: null,
            note: null,
          },
          cartRef.current.customer?.price_tier ?? 'retail',
        ).unit_price_paise
        if (unit > 0)
          qty = Math.max(1, Math.round((options.price_paise * product.pack_size * 1000) / unit))
      }
      if (qty === null && !options.confirmed && (product.is_weighed || allowsDecimalQty(product))) {
        setDialog({ name: 'weigh', product, options })
        return
      }
      dispatch({
        type: 'add',
        line: {
          product,
          qty_milli: qty ?? defaultQtyMilli(product),
          batch,
          batch_auto: auto,
          store_price: extras.store_price,
          tax_slabs: extras.tax_slabs,
          price_override_paise: null,
          discount_bp: 0,
          discount_paise: 0,
          serial_numbers: [],
          scanned_code: options.scanned_code ?? null,
          note: null,
        },
      })
      beepOk(sound)
      // Scheduled drugs: ask for the prescription once per bill.
      if (
        !cartRef.current.rx &&
        rxPromptedFor.current !== cartRef.current.id &&
        lineRequiresRx(product.attributes, context.settings.pharmacy.require_rx_for_schedules)
      ) {
        rxPromptedFor.current = cartRef.current.id
        setDialog({ name: 'rx' })
      }
    },
    [scope, context, today, sound, t, dispatch],
  )

  const addByCode = useCallback(
    async (code: string, multiplierMilli: number | null = null): Promise<boolean> => {
      if (!scope || !context) return false
      const trimmed = code.trim()
      if (!trimmed) return false
      // "3*" + code: three of what the code stands for (a case barcode: three cases). A price
      // label already fixes the amount, so it is added once.
      const add = (product: PosProduct, qty: number | null, price: number | null): Promise<void> =>
        multiplierMilli && price === null
          ? addProduct(product, {
              qty_milli: Math.round((multiplierMilli * (qty ?? defaultQtyMilli(product))) / 1000),
              scanned_code: trimmed,
              confirmed: true,
            })
          : addProduct(product, { qty_milli: qty, price_paise: price, scanned_code: trimmed })
      const local = await lookupCode(scope.tenantId, trimmed, context)
      if (local) {
        await add(local.product, local.qty_milli, local.price_paise)
        return true
      }
      if (online && perms.catalogRead) {
        try {
          const res = await callRoute(catalogRoutes.lookupProduct, {
            query: { code: trimmed, store_id: scope.storeId },
          })
          await add(
            sellableToPosProduct(res.data.product),
            res.data.qty_milli,
            res.data.price_paise,
          )
          // The catalogue changed since the last sync: fetch the delta.
          void catalog.refresh()
          return true
        } catch (e) {
          if (!(isApiError(e) && e.status === 404)) {
            beepError(sound)
            notify.error(e)
            return false
          }
        }
      }
      beepError(sound)
      notify.error(t('errors.code_not_found', { code: trimmed }), { id: 'pos-code-not-found' })
      return false
    },
    [scope, context, online, perms.catalogRead, addProduct, catalog, sound, t],
  )

  const setCustomer = useCallback(
    (customer: CartCustomer | null) => dispatch({ type: 'set_customer', customer }),
    [dispatch],
  )

  // ---- hold / recall --------------------------------------------------------------------------

  const saveLocalHeld = useCallback(
    async (c: CartState, label: string | null, id: string) => {
      if (!scope) return
      await heldCarts.save({
        id,
        tenant_id: scope.tenantId,
        store_id: scope.storeId,
        register_id: scope.registerId,
        label: label ?? '',
        customer_name: c.customer?.name ?? null,
        item_count: c.lines.length,
        total_paise: priceLocalCart(
          c,
          pricingEnv ?? {
            tax_mode: 'regular',
            round_off: 'none',
            store_id: '',
            timezone,
            promotions: [],
            loyalty: null,
          },
        ).result.total_paise,
        cart: c,
      })
    },
    [scope, pricingEnv, timezone],
  )

  const hold = useCallback(
    async (label: string | null = null) => {
      const c = cartRef.current
      const s = cartScope()
      if (!s || !scope || c.lines.length === 0) return
      setBusy('hold')
      try {
        if (online && perms.createSales) {
          try {
            let invoiceId: string
            let updatedAt: string
            if (c.held_invoice_id) {
              const res = await callRoute(salesRoutes.updateInvoice, {
                params: { id: c.held_invoice_id },
                body: heldUpdateBody(c, s),
              })
              invoiceId = res.data.id
              updatedAt = res.data.updated_at
            } else {
              const res = await callRoute(salesRoutes.createInvoice, {
                body: heldCreateBody(c, s, label),
                idempotencyKey: c.id,
              })
              invoiceId = res.data.invoice.id
              updatedAt = res.data.invoice.updated_at
            }
            await saveLocalHeld(
              { ...c, held_invoice_id: invoiceId, held_updated_at: updatedAt },
              label,
              invoiceId,
            )
            void invalidateRoutes(queryClient, [salesRoutes.listHeld])
            dispatch({ type: 'clear' })
            notify.success(t('held.saved'))
            focusSearch()
            return
          } catch (e) {
            if (!isOfflineError(e)) {
              notify.error(e)
              return
            }
          }
        }
        // Offline (or no server): park on this device. A fresh id: the server may have stored
        // the held bill under the old client_ref before the connection dropped.
        const parked = c.held_invoice_id ? c : { ...c, id: newId() }
        await saveLocalHeld(parked, label, c.held_invoice_id ?? parked.id)
        dispatch({ type: 'clear' })
        notify.success(t('held.saved_device'))
        focusSearch()
      } finally {
        setBusy(null)
      }
    },
    [
      cartScope,
      scope,
      online,
      perms.createSales,
      saveLocalHeld,
      queryClient,
      dispatch,
      t,
      focusSearch,
    ],
  )

  const loadCart = useCallback(
    async (next: CartState) => {
      // A bill in progress is parked first, never dropped.
      if (cartRef.current.lines.length > 0 && cartRef.current.id !== next.id) await hold(null)
      dispatch({ type: 'load', cart: next })
      setLastSale(null)
      setDialog(null)
      focusSearch()
    },
    [hold, dispatch, focusSearch],
  )

  const recallServer = useCallback(
    async (invoiceId: string) => {
      if (!scope || !context) return
      setBusy('recall')
      try {
        const local = await heldCarts.get(invoiceId)
        const res = await callRoute(salesRoutes.getInvoice, { params: { id: invoiceId } })
        const detail = res.data
        if (detail.status !== 'held' && detail.status !== 'draft') {
          notify.error(t('held.already_completed'))
          if (local) await heldCarts.remove(invoiceId)
          void invalidateRoutes(queryClient, [salesRoutes.listHeld])
          return
        }
        if (local && (local.cart as CartState | undefined)?.held_invoice_id === invoiceId) {
          await loadCart({ ...(local.cart as CartState), held_updated_at: detail.updated_at })
          return
        }
        const lines = recalledLines(detail)
        const products = new Map(
          (
            await getProducts(
              scope.tenantId,
              lines.map((l) => l.product_id),
            )
          ).map((p) => [p.id, p]),
        )
        const next = emptyCart()
        next.id = detail.client_ref ?? next.id
        next.held_invoice_id = detail.id
        next.held_updated_at = detail.updated_at
        next.notes = detail.notes
        next.rx = detail.rx
        next.loyalty_redeem_points = detail.loyalty_points_redeemed
        if (detail.customer) {
          const cached = context.customers.find((c) => c.id === detail.customer?.id)
          next.customer = {
            id: detail.customer.id,
            name: detail.customer.name,
            name_ta: cached?.name_ta ?? null,
            phone: detail.customer.phone,
            gstin: detail.customer_gstin,
            state_code: detail.customer_state_code,
            price_tier: cached?.price_tier ?? 'retail',
            balance_paise: detail.customer.balance_paise,
            credit_limit_paise: detail.customer.credit_limit_paise,
            loyalty_points: detail.customer.loyalty_points,
          }
        }
        let missing = 0
        for (const l of lines) {
          const product = products.get(l.product_id)
          if (!product) {
            missing++
            continue
          }
          const extras = await lineExtras(scope.tenantId, context, product, today)
          const batch = l.batch_id
            ? (extras.batches.find((b) => b.id === l.batch_id) ?? null)
            : extras.batch
          next.lines.push({
            key: l.key,
            product,
            qty_milli: l.qty_milli,
            batch,
            batch_auto: !l.batch_id,
            store_price: extras.store_price,
            tax_slabs: extras.tax_slabs,
            price_override_paise: l.unit_price_paise,
            discount_bp: l.discount_bp,
            discount_paise: l.discount_paise,
            serial_numbers: l.serial_numbers,
            scanned_code: l.scanned_code,
            note: l.note,
          })
        }
        // Manual bill discount = stored bill discount − loyalty − promotion bill discounts.
        if (pricingEnv) {
          const withoutManual = priceLocalCart(
            { ...next, bill_discount_paise: 0, bill_discount_bp: 0 },
            pricingEnv,
          )
          next.bill_discount_paise = Math.max(
            0,
            detail.bill_discount_paise -
              detail.loyalty_redeem_paise -
              withoutManual.result.promotion_bill_discount_paise,
          )
        }
        next.selected_key = next.lines[0]?.key ?? null
        if (missing > 0) notify.warning(t('held.missing_products', { count: missing }))
        await loadCart(next)
      } catch (e) {
        notify.error(e)
      } finally {
        setBusy(null)
      }
    },
    [scope, context, today, pricingEnv, loadCart, queryClient, t],
  )

  const recallLocal = useCallback(
    async (heldId: string) => {
      const row = await heldCarts.get(heldId)
      if (!row) return
      const saved = row.cart as CartState
      await heldCarts.remove(heldId)
      await loadCart(saved)
    },
    [loadCart],
  )

  // ---- estimates ------------------------------------------------------------------------------

  const saveEstimate = useCallback(async () => {
    const c = cartRef.current
    const s = cartScope()
    if (!s || c.lines.length === 0) return
    if (!online) {
      notify.error(t('estimate.needs_connection'))
      return
    }
    setBusy('estimate')
    try {
      const res = await callRoute(salesRoutes.createEstimate, {
        body: estimateBody(c, s),
        idempotencyKey: c.id,
      })
      notify.success(t('estimate.saved', { number: res.data.number ?? '' }))
      await meta.set(posMetaKeys.lastPrint(scope!.tenantId, scope!.key), {
        kind: 'server',
        id: res.data.id,
      } satisfies LastPrint)
      if (autoPrint) {
        void printSalesDocument({ kind: 'invoice', id: res.data.id, silent: silentPrint }).catch(
          (e: unknown) => notify.error(e),
        )
      }
      if (c.held_invoice_id) await heldCarts.remove(c.held_invoice_id)
      dispatch({ type: 'clear' })
      focusSearch()
    } catch (e) {
      notify.error(e)
    } finally {
      setBusy(null)
    }
  }, [cartScope, online, t, scope, autoPrint, silentPrint, dispatch, focusSearch])

  // ---- printing -------------------------------------------------------------------------------

  const printModelSafely = useCallback(
    (model: SalesPrintModel) => {
      void printSalesModel(model, {
        silent: silentPrint,
        copies: context?.settings.invoice.copies ?? 1,
      }).catch((e: unknown) => notify.error(e))
    },
    [silentPrint, context],
  )

  const printLast = useCallback(async () => {
    if (!scope) return
    const last = await meta.get<LastPrint>(posMetaKeys.lastPrint(scope.tenantId, scope.key))
    if (!last) {
      notify.info(t('print.nothing_to_reprint'))
      return
    }
    try {
      if (last.kind === 'server') {
        await printSalesDocument({ kind: 'invoice', id: last.id, silent: silentPrint })
      } else {
        await printSalesModel(last.model, { silent: silentPrint })
      }
    } catch (e) {
      notify.error(e)
    }
  }, [scope, silentPrint, t])

  // ---- checkout -------------------------------------------------------------------------------

  const finishSale = useCallback(
    (sale: CompletedSale, c: CartState) => {
      setLastSale(sale)
      display.send({
        type: 'thank_you',
        total_paise: sale.total_paise,
        paid_paise: sale.paid_paise,
        change_paise: sale.change_paise,
        invoice_number: sale.number,
      })
      if (c.held_invoice_id) void heldCarts.remove(c.held_invoice_id)
      dispatch({ type: 'clear' })
      setDialog(null)
      focusSearch()
    },
    [display, dispatch, focusSearch],
  )

  const completeSale = useCallback(
    async (tenders: PosTender[], options: CompleteOptions = {}): Promise<SaleOutcome> => {
      const c = cartRef.current
      const s = cartScope()
      if (!s || !scope || !context || !pricingEnv)
        return { status: 'error', message: t('errors.not_ready') }
      if (c.lines.length === 0) return { status: 'error', message: t('errors.empty_cart') }
      const local = priceLocalCart(c, pricingEnv)
      if (local.error)
        return { status: 'error', message: t('errors.pricing', { error: local.error }) }
      if (rxNeeded) return { status: 'needs_rx' }
      const tenderInputs = toTenderInputs(tenders)
      const summary = summarizeTenders(local.result.total_paise, tenders)
      if (summary.issue && !options.accept_server_total) {
        return {
          status: 'error',
          message:
            summary.issue.code === 'tender_exceeds_due'
              ? t('payment.tender_exceeds_due')
              : t('payment.cash_not_needed'),
        }
      }
      setBusy('checkout')
      try {
        // ---- online: authoritative quote, then create / complete ----------------------------
        if (online) {
          try {
            const quote = (
              await callRoute(salesRoutes.posQuote, {
                body: quoteRequest(c, s, tenderInputs, options),
              })
            ).data
            const blocking = quote.issues.filter((i) => i.severity === 'error')
            if (!quote.can_complete || blocking.length > 0) {
              return { status: 'blocked', issues: blocking }
            }
            const diff = quoteDiff(local, quote)
            if (diff && diff.total_paise !== 0 && !options.accept_server_total) {
              return { status: 'price_changed', quote, server_total_paise: quote.total_paise }
            }
            let result: InvoiceSaveResult
            if (c.held_invoice_id) {
              result = (
                await callRoute(salesRoutes.completeInvoice, {
                  params: { id: c.held_invoice_id },
                  body: {
                    tenders: tenderInputs,
                    ...(scope.registerId ? { register_id: scope.registerId } : {}),
                    client_ref: `complete:${c.id}`,
                    credit_limit_override: options.credit_limit_override === true,
                    changes: heldUpdateBody(c, s),
                  },
                  idempotencyKey: `complete:${c.id}`,
                })
              ).data
            } else {
              result = (
                await callRoute(salesRoutes.createInvoice, {
                  body: invoiceCreateBody(c, s, tenderInputs, options),
                  idempotencyKey: c.id,
                })
              ).data
            }
            const inv = result.invoice
            if (context.series) {
              void advanceSeriesPast(scope.tenantId, scope.key, context.series.doc_type, inv.number)
            }
            await meta.set(posMetaKeys.lastPrint(scope.tenantId, scope.key), {
              kind: 'server',
              id: inv.id,
            } satisfies LastPrint)
            if (autoPrint) {
              void printSalesDocument({
                kind: 'invoice',
                id: inv.id,
                silent: silentPrint,
                copies: context.settings.invoice.copies,
              }).catch((e: unknown) => notify.error(e))
            }
            void invalidateRoutes(queryClient, [salesRoutes.listInvoices, salesRoutes.listHeld])
            const sale: CompletedSale = {
              mode: 'online',
              invoice_id: inv.id,
              number: inv.number,
              total_paise: inv.total_paise,
              paid_paise: inv.paid_paise,
              change_paise: result.change_paise,
              due_paise: inv.due_paise,
              customer_name: inv.customer_name,
              customer_phone: inv.customer_phone,
              warnings: result.warnings,
              at: new Date().toISOString(),
            }
            finishSale(sale, c)
            return { status: 'done', sale }
          } catch (e) {
            if (!isOfflineError(e)) {
              const issues = issuesOfError(e)
              if (issues.length) return { status: 'blocked', issues }
              return { status: 'error', message: isApiError(e) ? e.message : String(e) }
            }
            // Fall through: the server went away mid-checkout. client_ref keeps it idempotent.
          }
        }

        // ---- offline: number locally, queue, print --------------------------------------------
        if (!scope.registerId)
          return { status: 'error', message: t('errors.offline_needs_register') }
        if (tenders.some((x) => x.payment_intent_id)) {
          return { status: 'error', message: t('errors.offline_dynamic_upi') }
        }
        const createdAt = new Date().toISOString()
        // A recalled held bill keeps its own client_ref on the server: the offline bill is new.
        const clientRef = c.held_invoice_id ? newId() : c.id
        const entry = await queueOfflineDocument({
          entry: {
            client_ref: clientRef,
            tenant_id: scope.tenantId,
            store_id: scope.storeId,
            register_id: scope.registerId,
            kind: 'invoice',
          },
          docType: context.series?.doc_type ?? null,
          date: today,
          fyStartMonth: context.tenant.fy_start_month,
          registerKey: scope.key,
          build: (number) =>
            syncInvoiceBody(c, s, {
              client_ref: clientRef,
              tenders: tenderInputs,
              offline_number: number,
              invoice_date: today,
              created_at: createdAt,
              credit_limit_override: options.credit_limit_override === true,
            }),
        })
        const model = buildOfflinePrintModel({
          context,
          cart: c,
          pricing: local,
          tenders: tenderInputs,
          number: entry.number,
          invoice_date: today,
          created_at: entry.created_at,
          cashier_name: me?.user.full_name ?? null,
          locale: getLanguage(),
        })
        await meta.set(posMetaKeys.lastPrint(scope.tenantId, scope.key), {
          kind: 'model',
          model,
        } satisfies LastPrint)
        if (autoPrint) printModelSafely(model)
        const sale: CompletedSale = {
          mode: 'offline',
          invoice_id: null,
          number: entry.number,
          total_paise: local.result.total_paise,
          paid_paise: summary.paid_paise,
          change_paise: summary.change_paise,
          due_paise: summary.due_paise,
          customer_name: c.customer?.name ?? null,
          customer_phone: c.customer?.phone ?? null,
          warnings: [],
          at: createdAt,
        }
        finishSale(sale, c)
        return { status: 'done', sale }
      } finally {
        setBusy(null)
      }
    },
    [
      cartScope,
      scope,
      context,
      pricingEnv,
      t,
      rxNeeded,
      online,
      autoPrint,
      silentPrint,
      queryClient,
      finishSale,
      today,
      me,
      printModelSafely,
    ],
  )

  const clearCart = useCallback(() => {
    const c = cartRef.current
    if (c.held_invoice_id) {
      // A recalled held bill stays held on the server; only the local copy is dropped.
      void heldCarts.remove(c.held_invoice_id)
    }
    dispatch({ type: 'clear' })
    setLastSale(null)
    focusSearch()
  }, [dispatch, focusSearch])

  const api: PosApi = {
    scope,
    context,
    catalogStatus: catalog.status,
    catalogSyncing: catalog.syncing,
    catalogError: catalog.error,
    catalogRevision: catalog.revision,
    refreshCatalog: catalog.refresh,
    online,
    cart,
    cartRestored: restored,
    dispatch,
    pricing,
    pricingEnv,
    today,
    perms,
    hasFeature,
    outbox,
    scale,
    display: displayApi,
    dialog,
    openDialog,
    closeDialog,
    busy,
    lastSale,
    dismissLastSale: () => setLastSale(null),
    silentPrint,
    addProduct,
    addByCode,
    setCustomer,
    hold,
    recallServer,
    recallLocal,
    saveEstimate,
    completeSale,
    printLast,
    clearCart,
    rxNeeded,
    searchRef,
    customerRef,
    focusSearch,
  }
  return <PosCtx.Provider value={api}>{children}</PosCtx.Provider>
}
