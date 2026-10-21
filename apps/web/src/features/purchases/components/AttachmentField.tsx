/**
 * Supplier invoice photo / PDF of a bill (files API, purpose 'attachment'): take a photo with the
 * phone camera or pick a file, see the thumbnail, open it full size, remove it. Limits come from
 * FILE_UPLOAD_RULES and are checked before uploading.
 */
import { FILE_UPLOAD_RULES, fileUploadIssue } from '@kadai/shared/api/identity'
import { Camera, ExternalLink, FileText, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Spinner, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { uploadFile, useFileInfo, useFileObjectUrl } from '../api'

export interface AttachmentFieldProps {
  fileId: string | null
  onChange: (fileId: string | null) => void
  readOnly?: boolean
  className?: string
}

const RULE = FILE_UPLOAD_RULES.attachment

export function AttachmentField({ fileId, onChange, readOnly, className }: AttachmentFieldProps) {
  const { t } = useTranslation('purchases')
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const info = useFileInfo(fileId)
  const content = useFileObjectUrl(fileId)
  const isImage = (info.data?.data.content_type ?? content.type ?? '').startsWith('image/')

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const issue = fileUploadIssue('attachment', file)
    if (issue) {
      notify.error(t(`attachment.${issue}`, { size: Math.round(RULE.max_bytes / (1024 * 1024)) }))
      return
    }
    setUploading(true)
    try {
      const uploaded = await uploadFile(file, 'attachment')
      onChange(uploaded.id)
      notify.success(t('attachment.uploaded'))
    } catch (error) {
      notify.error(error)
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ''
    }
  }

  if (!fileId) {
    if (readOnly) return <p className="text-sm text-muted-foreground">{t('attachment.none')}</p>
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <input
          ref={input}
          type="file"
          accept={RULE.accept}
          capture="environment"
          className="sr-only"
          aria-label={t('attachment.choose')}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button
          variant="outline"
          leftIcon={<Camera />}
          loading={uploading}
          onClick={() => input.current?.click()}
          className="justify-start"
        >
          {uploading ? t('attachment.uploading') : t('attachment.add')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t('attachment.hint', { size: Math.round(RULE.max_bytes / (1024 * 1024)) })}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <a
        href={content.url ?? undefined}
        target="_blank"
        rel="noreferrer"
        aria-label={t('attachment.open')}
        className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {content.loading ? (
          <Spinner size="sm" label={t('attachment.loading')} />
        ) : content.url && isImage ? (
          <img
            src={content.url}
            alt={t('attachment.preview_alt')}
            className="size-full object-cover"
          />
        ) : (
          <FileText className="size-8 text-muted-foreground" />
        )}
      </a>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {info.data?.data.filename ?? t('attachment.attached')}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {content.url ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={content.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                {t('attachment.open')}
              </a>
            </Button>
          ) : null}
          {!readOnly ? (
            <IconButton
              icon={<Trash2 />}
              label={t('attachment.remove')}
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
