/**
 * Offline bills of this counter (outbox): waiting / uploading / failed / uploaded, with the
 * number printed offline and the server's number when it was renumbered. Failed bills show the
 * reason and can be retried; nothing is ever deleted from here (they are real sales).
 */
import { AlertTriangle, CheckCircle2, CloudUpload, RefreshCcw, Shuffle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Drawer, EmptyState } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import type { OutboxEntry } from '@/lib/offline/db'
import { usePos } from '../state/pos-context'

function lineCount(entry: OutboxEntry): number | null {
  const payload = entry.payload as { lines?: unknown[] } | null
  return Array.isArray(payload?.lines) ? payload.lines.length : null
}

function StatusBadge({ entry }: { entry: OutboxEntry }) {
  const { t } = useTranslation('pos')
  if (entry.status === 'synced')
    return entry.renumbered ? (
      <Badge tone="warning" icon={<Shuffle />}>
        {t('sync.renumbered')}
      </Badge>
    ) : (
      <Badge tone="success" icon={<CheckCircle2 />}>
        {t('sync.synced')}
      </Badge>
    )
  if (entry.status === 'failed')
    return (
      <Badge tone="danger" icon={<AlertTriangle />}>
        {t('sync.failed')}
      </Badge>
    )
  if (entry.status === 'syncing') return <Badge tone="info">{t('sync.syncing')}</Badge>
  return <Badge tone="neutral">{t('sync.pending')}</Badge>
}

export function SyncDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const { outbox } = pos
  const entries = [...outbox.entries].reverse()
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('sync.title')}
      description={t('sync.description', { count: outbox.unsynced })}
      footer={
        <Button
          leftIcon={<RefreshCcw />}
          onClick={() => void outbox.syncNow()}
          loading={outbox.syncing}
          disabled={!pos.online || outbox.unsynced === 0}
          fullWidth
        >
          {pos.online ? t('sync.sync_now') : t('sync.waiting_connection')}
        </Button>
      }
    >
      {entries.length === 0 ? (
        <EmptyState
          compact
          icon={<CloudUpload />}
          title={t('sync.empty')}
          description={t('sync.empty_hint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.client_ref} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold">
                  {e.number ?? t('sync.no_number')}
                  {e.renumbered && e.server_number ? (
                    <span className="ms-1 text-warning-soft-foreground"> → {e.server_number}</span>
                  ) : null}
                </span>
                <StatusBadge entry={e} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{formatDateTime(e.created_at)}</span>
                {lineCount(e) !== null ? (
                  <span>{t('sync.items', { count: lineCount(e) ?? 0 })}</span>
                ) : null}
              </div>
              {e.status === 'failed' && e.last_error ? (
                <p className="mt-1 text-xs text-danger">
                  {e.last_error.code}: {e.last_error.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}
