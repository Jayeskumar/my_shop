/** F1: the counter's keyboard map and hardware tips (scanner, scale, receipt printer, drawer). */
import { Barcode, Printer, Scale, Vault } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, Kbd } from '@/components/ui'
import { HELP_ORDER, POS_KEYMAP } from '../lib/keymap'
import { usePos } from '../state/pos-context'

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const register = pos.context?.register
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('help.title')}
      description={t('help.description')}
      size="lg"
    >
      <div className="grid gap-6 pb-2 md:grid-cols-[1.2fr_1fr]">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {HELP_ORDER.map((a) => (
            <div key={a} className="contents">
              <dt>
                <Kbd combo={POS_KEYMAP[a]} className="h-7 min-w-10 text-xs" />
              </dt>
              <dd>{t(`actions.${a}`)}</dd>
            </div>
          ))}
          <dt>
            <Kbd className="h-7 min-w-10 text-xs">3*</Kbd>
          </dt>
          <dd>{t('help.multiplier')}</dd>
        </dl>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex gap-2">
            <Barcode className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p>{t('help.scanner')}</p>
          </div>
          <div className="flex gap-2">
            <Scale className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p>{register?.settings.scale.enabled ? t('help.scale_on') : t('help.scale_off')}</p>
          </div>
          <div className="flex gap-2">
            <Printer className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p>{pos.silentPrint ? t('help.print_silent') : t('help.print_dialog')}</p>
          </div>
          {register?.settings.cash_drawer ? (
            <div className="flex gap-2">
              <Vault className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <p>{t('help.cash_drawer')}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
