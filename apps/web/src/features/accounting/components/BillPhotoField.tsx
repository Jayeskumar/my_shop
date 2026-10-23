/**
 * Bill photo of an expense: take a picture with the phone camera or choose an image / PDF; it is
 * checked (type, 10 MB) and uploaded right away (POST /files?purpose=attachment), and the form
 * keeps only the file id. A local preview is shown while the form is open.
 */
import { Camera, FileText, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton } from '@/components/ui'
import { formatNumber } from '@/lib/format'
import { ATTACHMENT_RULE, attachmentIssue, uploadAttachment } from '../lib/files'
import { notifyAccountingError } from '../lib/errors'

export function BillPhotoField({
  value,
  onChange,
  onUploadingChange,
}: {
  value: string | null
  onChange: (fileId: string | null) => void
  onUploadingChange?: (uploading: boolean) => void
}) {
  const { t } = useTranslation('accounting')
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)

  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // The form was reset: forget the local file.
  useEffect(() => {
    if (value === null && !uploading) setFile(null)
  }, [value, uploading])

  const pick = async (picked: File | undefined): Promise<void> => {
    if (!picked) return
    const problem = attachmentIssue(picked)
    if (problem) {
      setIssue(
        t(`expenses.photo.${problem}`, {
          size: formatNumber(ATTACHMENT_RULE.max_bytes / (1024 * 1024)),
        }),
      )
      return
    }
    setIssue(null)
    setFile(picked)
    setUploading(true)
    onUploadingChange?.(true)
    try {
      const meta = await uploadAttachment(picked)
      onChange(meta.id)
    } catch (error) {
      setFile(null)
      onChange(null)
      notifyAccountingError(error)
    } finally {
      setUploading(false)
      onUploadingChange?.(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        type="file"
        accept={ATTACHMENT_RULE.accept}
        className="sr-only"
        tabIndex={-1}
        aria-label={t('expenses.photo.choose')}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {file || value ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 p-2">
          {preview ? (
            <img src={preview} alt="" className="size-14 rounded-md object-cover" />
          ) : (
            <span className="flex size-14 items-center justify-center rounded-md bg-surface-3 text-muted-foreground">
              <FileText className="size-6" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1 text-sm">
            <div className="truncate font-medium">{file?.name ?? t('expenses.photo.attached')}</div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {uploading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t('expenses.photo.uploading')}
                </>
              ) : (
                t('expenses.photo.uploaded')
              )}
            </div>
          </div>
          <IconButton
            icon={<X />}
            label={t('expenses.photo.remove')}
            disabled={uploading}
            onClick={() => {
              setFile(null)
              onChange(null)
            }}
          />
        </div>
      ) : (
        <Button
          variant="outline"
          leftIcon={<Camera />}
          onClick={() => input.current?.click()}
          className="justify-start"
        >
          {t('expenses.photo.add')}
        </Button>
      )}
      {issue ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {issue}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('expenses.photo.hint')}</p>
      )}
    </div>
  )
}
