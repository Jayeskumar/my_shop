import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Button } from './button'

export interface ErrorFallbackProps {
  error: unknown
  reset?: () => void
  className?: string
}

/** Localized "something went wrong" panel with retry / reload and technical details. */
export function ErrorFallback({ error, reset, className }: ErrorFallbackProps) {
  const { t } = useTranslation(['errors', 'common'])
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  return (
    <div role="alert" className={cn('mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-16 text-center', className)}>
      <span className="flex size-16 items-center justify-center rounded-2xl bg-danger-soft text-danger">
        <AlertTriangle className="size-8" />
      </span>
      <h2 className="text-lg font-semibold">{t('pages.crash_title')}</h2>
      <p className="text-sm text-muted-foreground">{t('pages.crash_description')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {reset ? (
          <Button onClick={reset} leftIcon={<RotateCcw />}>
            {t('common:actions.retry')}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => window.location.reload()} leftIcon={<RefreshCw />}>
          {t('common:actions.reload')}
        </Button>
      </div>
      <details className="w-full text-start text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">{t('pages.technical_details')}</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-mono">
          {message}
          {import.meta.env.DEV && stack ? `\n\n${stack}` : ''}
        </pre>
      </details>
    </div>
  )
}

export interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: (props: { error: unknown; reset: () => void }) => ReactNode
  /** When any value changes (e.g. the route), a shown error is cleared. */
  resetKeys?: readonly unknown[]
  onError?: (error: unknown, info: ErrorInfo) => void
}

interface State {
  error: unknown
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, hasError: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('UI error', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (!this.state.hasError) return
    const a = prev.resetKeys ?? []
    const b = this.props.resetKeys ?? []
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) this.reset()
  }

  reset = (): void => {
    this.setState({ error: null, hasError: false })
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ? (
        this.props.fallback({ error: this.state.error, reset: this.reset })
      ) : (
        <ErrorFallback error={this.state.error} reset={this.reset} />
      )
    }
    return this.props.children
  }
}
