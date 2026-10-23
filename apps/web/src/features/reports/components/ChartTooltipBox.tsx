/** Tooltip card of the Recharts charts (title + one line per series with its swatch). */
export interface ChartTooltipLine {
  key: string
  label: string
  value: string
  /** Swatch colour (CSS colour / var()); omitted for plain lines such as "Bills". */
  color?: string
}

export function ChartTooltipBox({ title, lines }: { title: string; lines: ChartTooltipLine[] }) {
  return (
    <div className="min-w-44 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-overlay">
      <p className="mb-1.5 font-semibold text-foreground">{title}</p>
      <dl className="grid gap-1">
        {lines.map((l) => (
          <div key={l.key} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              {l.color ? (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: l.color }}
                />
              ) : null}
              {l.label}
            </dt>
            <dd className="font-semibold tabular-nums text-foreground">{l.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Legend of a multi-series chart (identity is never colour-alone). */
export function ChartLegend({
  items,
}: {
  items: { key: string; label: string; color: string; kind?: 'bar' | 'line' }[]
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={i.kind === 'line' ? 'h-0.5 w-4 rounded-full' : 'size-2.5 rounded-sm'}
            style={{ backgroundColor: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  )
}
