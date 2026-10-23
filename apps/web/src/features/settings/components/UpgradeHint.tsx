/**
 * Friendly "your plan / licence does not include this" callout (402 FEATURE_NOT_IN_PLAN /
 * PLAN_LIMIT_REACHED, or a limit the UI can see coming). Cloud owners get a link to Plan &
 * billing; on-prem shops are pointed to the licence screen (add-ons are bought there).
 */
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { FEATURE_LABELS, LIMIT_LABELS } from '@kadai/shared/features'
import { Button } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'
import type { PlanBlock } from '../lib/messages'

export function UpgradeHint({ block, className }: { block: PlanBlock; className?: string }) {
  const { t } = useTranslation('settings')
  const mode = useAuth((s) => s.me?.mode ?? s.deployment.mode)
  const canBilling = useCan('billing.manage')
  const canSystem = useCan('settings.manage')
  const lng = getLanguage()
  const title =
    block.kind === 'feature'
      ? t('upgrade.feature_title', { feature: FEATURE_LABELS[block.feature][lng] })
      : block.limit === null
        ? t('upgrade.limit_title_generic', { what: LIMIT_LABELS[block.metric][lng] })
        : t('upgrade.limit_title', { what: LIMIT_LABELS[block.metric][lng], count: block.limit })
  const description = mode === 'onprem' ? t('upgrade.description_onprem') : t('upgrade.description')
  const cta =
    mode === 'onprem'
      ? canSystem
        ? { to: '/settings/system', label: t('upgrade.cta_onprem') }
        : null
      : canBilling
        ? { to: '/settings/billing', label: t('upgrade.cta') }
        : null
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4 text-accent-soft-foreground sm:flex-row sm:items-center',
        className,
      )}
    >
      <Sparkles className="size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-snug">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed opacity-90">{description}</p>
      </div>
      {cta ? (
        <Button asChild variant="accent" size="sm" className="self-start sm:self-center">
          <Link to={cta.to}>{cta.label}</Link>
        </Button>
      ) : null}
    </div>
  )
}
