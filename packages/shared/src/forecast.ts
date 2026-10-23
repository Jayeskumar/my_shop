/**
 * StockSense smart forecast: per-product model selection by backtest.
 *
 * Candidates
 *  - holt_winters: additive Holt-Winters with a damped trend and a weekly season (m = 7). Level,
 *    trend and weekday pattern are smoothed, so recent days weigh more than old ones. Smoothing
 *    constants are picked from a small grid by one-step-ahead squared error on the training data.
 *  - croston_sba: Croston's method with the Syntetos–Boylan bias correction, for intermittent
 *    demand (many zero days): smooths the size of non-zero sales and the interval between them.
 *  - weekday_average: mean of the same weekday over the last four weeks (the previous StockSense
 *    forecast) — the baseline the other models must beat.
 *
 * Each candidate is fitted on the history minus the last `holdout` days and scored on those days
 * by WAPE (Σ|actual − forecast| / Σ actual). The lowest WAPE wins (ties go to the simpler model),
 * is refitted on the full history and forecasts the lead time. Safety stock is
 * z × σ × √lead_time, with σ the standard deviation of the winner's daily backtest errors.
 *
 * Quantities are in milli-units like the rest of the domain; results are rounded integers.
 */

export const FORECAST_METHODS = ['holt_winters', 'croston_sba', 'weekday_average'] as const
export type ForecastMethod = (typeof FORECAST_METHODS)[number]

/** History used by the smart forecast (days, ending today). */
export const SMART_FORECAST_HISTORY_DAYS = 90
/** Days held out to score the candidates. */
export const SMART_FORECAST_HOLDOUT_DAYS = 14
/** z for the default 95% cycle service level. */
export const SAFETY_Z_95 = 1.645

const SEASON = 7
/** Holt-Winters needs two full weeks to initialise. */
const MIN_HW_TRAIN = 2 * SEASON
const DAMPING = 0.9

export interface SmartForecastInput {
  /** Daily net sales, oldest first; the last element is today. */
  history_milli: readonly number[]
  /** Weekday (0 = Sunday) of history_milli[0]. */
  first_weekday: number
  /** Days until the delivery arrives; day 1 of the horizon is tomorrow. */
  lead_time_days: number
  /** z of the service level (default 1.645 ≈ 95%). */
  z?: number
  /**
   * Standard deviation of the supplier's lead time (days). With it, safety stock also covers late
   * deliveries: z × √(L × σd² + d² × σL²).
   */
  lead_time_sd_days?: number
}

export interface ForecastCandidate {
  method: ForecastMethod
  /** WAPE on the holdout in basis points (lower is better); null when not scored. */
  wape_bp: number | null
}

export interface SmartForecast {
  method: ForecastMethod
  /** Average daily demand over the horizon. */
  daily_milli: number
  /** Demand over the lead time. */
  demand_milli: number
  safety_stock_milli: number
  /** 1 − WAPE of the chosen model on the holdout, in basis points (null without a backtest). */
  accuracy_bp: number | null
  /** Days held out for the backtest (0 = not enough history). */
  holdout_days: number
  has_history: boolean
  candidates: ForecastCandidate[]
}

type Model = (train: readonly number[], firstWeekday: number, horizon: number) => number[]

// ---- candidates ------------------------------------------------------------------------------

/** Mean of the same weekday over the last four weeks (overall mean when a weekday is missing). */
export const weekdayAverageModel: Model = (train, firstWeekday, horizon) => {
  const recent = Math.min(train.length, 4 * SEASON)
  const start = train.length - recent
  const sums = new Array<number>(SEASON).fill(0)
  const counts = new Array<number>(SEASON).fill(0)
  let total = 0
  for (let i = start; i < train.length; i++) {
    const dow = (firstWeekday + i) % SEASON
    sums[dow]! += train[i]!
    counts[dow]! += 1
    total += train[i]!
  }
  const overall = recent > 0 ? total / recent : 0
  const out: number[] = []
  for (let h = 1; h <= horizon; h++) {
    const dow = (firstWeekday + train.length - 1 + h) % SEASON
    out.push(counts[dow]! > 0 ? sums[dow]! / counts[dow]! : overall)
  }
  return out
}

/** Croston with the Syntetos–Boylan correction: flat forecast (1 − α/2) · size / interval. */
export function crostonSbaModel(alpha = 0.1): Model {
  return (train, _firstWeekday, horizon) => {
    let size: number | null = null
    let interval = 1
    let gap = 1
    for (const y of train) {
      if (y > 0) {
        if (size === null) {
          size = y
          interval = gap
        } else {
          size += alpha * (y - size)
          interval += alpha * (gap - interval)
        }
        gap = 1
      } else {
        gap += 1
      }
    }
    const rate = size === null ? 0 : ((1 - alpha / 2) * size) / Math.max(interval, 1)
    return new Array<number>(horizon).fill(rate)
  }
}

interface HwFit {
  sse: number
  level: number
  trend: number
  season: number[]
}

function fitHoltWinters(y: readonly number[], alpha: number, beta: number, gamma: number): HwFit {
  const m = SEASON
  const mean = (from: number, to: number): number => {
    let s = 0
    for (let i = from; i < to; i++) s += y[i]!
    return s / (to - from)
  }
  let level = mean(0, m)
  let trend = (mean(m, 2 * m) - level) / m
  const season = new Array<number>(y.length)
  for (let i = 0; i < m; i++) season[i] = y[i]! - level
  let sse = 0
  for (let t = m; t < y.length; t++) {
    const s = season[t - m]!
    const predicted = level + DAMPING * trend + s
    const err = y[t]! - predicted
    sse += err * err
    const prevLevel = level
    level = alpha * (y[t]! - s) + (1 - alpha) * (prevLevel + DAMPING * trend)
    trend = beta * (level - prevLevel) + (1 - beta) * DAMPING * trend
    season[t] = gamma * (y[t]! - level) + (1 - gamma) * s
  }
  return { sse, level, trend, season: season.slice(-m) }
}

const HW_ALPHAS = [0.1, 0.3, 0.5]
const HW_BETAS = [0.01, 0.1]
const HW_GAMMAS = [0.05, 0.2, 0.4]

/** Additive damped Holt-Winters, weekly season, constants by grid search on in-sample error. */
export const holtWintersModel: Model = (train, _firstWeekday, horizon) => {
  let best: HwFit | null = null
  for (const a of HW_ALPHAS) {
    for (const b of HW_BETAS) {
      for (const g of HW_GAMMAS) {
        const fit = fitHoltWinters(train, a, b, g)
        if (!best || fit.sse < best.sse) best = fit
      }
    }
  }
  const fit = best!
  const out: number[] = []
  let damp = 0
  for (let h = 1; h <= horizon; h++) {
    damp += DAMPING ** h
    // season holds the last m smoothed weekday effects; index h−1 is the weekday of day h.
    const s = fit.season[(h - 1) % SEASON]!
    out.push(Math.max(0, fit.level + damp * fit.trend + s))
  }
  return out
}

const MODELS: Readonly<Record<ForecastMethod, Model>> = {
  holt_winters: holtWintersModel,
  croston_sba: crostonSbaModel(),
  weekday_average: weekdayAverageModel,
}

/** Simpler models win ties. */
const SIMPLICITY: Readonly<Record<ForecastMethod, number>> = {
  weekday_average: 0,
  croston_sba: 1,
  holt_winters: 2,
}

function canRun(method: ForecastMethod, trainLength: number): boolean {
  if (method === 'holt_winters') return trainLength >= MIN_HW_TRAIN
  return trainLength >= 1
}

// ---- selection -------------------------------------------------------------------------------

export function smartForecast(input: SmartForecastInput): SmartForecast {
  const lead = input.lead_time_days
  if (!Number.isSafeInteger(lead) || lead <= 0) throw new RangeError('lead_time_days must be > 0')
  const z = input.z ?? SAFETY_Z_95
  const y = input.history_milli.map((v) => Math.max(0, Number.isFinite(v) ? v : 0))
  const total = y.reduce((s, v) => s + v, 0)
  if (y.length === 0 || total <= 0) {
    return {
      method: 'weekday_average',
      daily_milli: 0,
      demand_milli: 0,
      safety_stock_milli: 0,
      accuracy_bp: null,
      holdout_days: 0,
      has_history: false,
      candidates: [],
    }
  }

  // Backtest on the last `holdout` days when there is enough history to train and to score.
  const holdout = y.length >= 3 * SEASON ? Math.min(SMART_FORECAST_HOLDOUT_DAYS, Math.floor(y.length / 3)) : 0
  const train = y.slice(0, y.length - holdout)
  const actual = y.slice(y.length - holdout)
  const actualSum = actual.reduce((s, v) => s + v, 0)

  const candidates: (ForecastCandidate & { errors: number[] })[] = []
  for (const method of FORECAST_METHODS) {
    if (holdout === 0 || actualSum <= 0) {
      candidates.push({ method, wape_bp: null, errors: [] })
      continue
    }
    if (!canRun(method, train.length)) continue
    const predicted = MODELS[method](train, input.first_weekday, holdout)
    const errors = actual.map((a, i) => a - predicted[i]!)
    const absErr = errors.reduce((s, e) => s + Math.abs(e), 0)
    candidates.push({ method, wape_bp: Math.round((absErr / actualSum) * 10_000), errors })
  }

  const scored = candidates.filter((c) => c.wape_bp !== null)
  let chosen: (typeof candidates)[number]
  if (scored.length > 0) {
    chosen = scored.reduce((best, c) =>
      c.wape_bp! < best.wape_bp! ||
      (c.wape_bp === best.wape_bp && SIMPLICITY[c.method] < SIMPLICITY[best.method])
        ? c
        : best,
    )
  } else {
    // No backtest possible: the weekday average (works with any history length).
    chosen = candidates.find((c) => c.method === 'weekday_average')!
  }

  const horizon = MODELS[chosen.method](y, input.first_weekday, lead)
  const demand = Math.round(horizon.reduce((s, v) => s + v, 0))

  // Safety stock = z × √(L × σd² + d² × σL²): demand error over the lead time plus late deliveries.
  let demandVariance = 0
  if (chosen.errors.length >= 2) {
    const meanErr = chosen.errors.reduce((s, e) => s + e, 0) / chosen.errors.length
    demandVariance =
      chosen.errors.reduce((s, e) => s + (e - meanErr) ** 2, 0) / (chosen.errors.length - 1)
  }
  const sdLead = Math.max(0, input.lead_time_sd_days ?? 0)
  const dailyDemand = demand / lead
  const safety =
    demand > 0
      ? Math.round(z * Math.sqrt(lead * demandVariance + dailyDemand ** 2 * sdLead ** 2))
      : 0

  return {
    method: chosen.method,
    daily_milli: Math.round(demand / lead),
    demand_milli: demand,
    safety_stock_milli: safety,
    accuracy_bp:
      chosen.wape_bp === null ? null : Math.max(0, Math.min(10_000, 10_000 - chosen.wape_bp)),
    holdout_days: chosen.wape_bp === null ? 0 : holdout,
    has_history: demand > 0,
    candidates: candidates.map(({ method, wape_bp }) => ({ method, wape_bp })),
  }
}
