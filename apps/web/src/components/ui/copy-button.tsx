import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/lib/clipboard'
import { IconButton, type IconButtonProps } from './icon-button'

export interface CopyButtonProps extends Omit<IconButtonProps, 'icon' | 'label' | 'onClick'> {
  value: string
  label?: string
  onCopied?: () => void
}

export function CopyButton({ value, label, onCopied, size = 'sm', ...props }: CopyButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      size={size}
      label={copied ? t('actions.copied') : (label ?? t('actions.copy'))}
      icon={copied ? <Check className="text-success" /> : <Copy />}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyToClipboard(value)) {
          setCopied(true)
          onCopied?.()
        }
      }}
      {...props}
    />
  )
}
