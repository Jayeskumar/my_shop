/**
 * Financial statements (/accounting/statements): Profit & loss (இலாப நஷ்ட கணக்கு), Balance sheet
 * (இருப்புநிலைக் குறிப்பு) and Trial balance (சோதனை இருப்பு) as tabs (?tab=pl|bs|tb), each with
 * its own period / as-of picker, print and CSV. Account names open their ledger.
 */
import { ListTree } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { ACCOUNTING_TITLES } from '@kadai/shared/api/accounting'
import { Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { BalanceSheetPanel } from '../components/BalanceSheetPanel'
import { ProfitLossPanel } from '../components/ProfitLossPanel'
import { TrialBalancePanel } from '../components/TrialBalancePanel'
import { bi } from '../lib/labels'
import { useUrlState } from '../lib/url-state'

const TABS = ['pl', 'bs', 'tb'] as const
type Tab = (typeof TABS)[number]
/** Phones: three equal tabs whose (long Tamil) names may wrap onto two lines. */
const TAB_CLASS =
  'h-auto min-h-10 whitespace-normal px-2 py-1.5 text-center leading-tight sm:h-8 sm:min-h-0 sm:whitespace-nowrap sm:px-3'

export default function StatementsPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const url = useUrlState()
  const tab = url.oneOf('tab', TABS, 'pl')
  return (
    <div>
      <PageHeader
        title={t('statements.title')}
        description={t('statements.description')}
        actions={
          <Button asChild variant="ghost">
            <Link to="/accounting/accounts">
              <ListTree aria-hidden />
              {t('accounts.title')}
            </Link>
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => url.set({ tab: v === 'pl' ? null : (v as Tab) })}
        variant="pills"
      >
        <TabsList
          aria-label={t('statements.title')}
          className="grid w-full grid-cols-3 sm:flex sm:w-fit"
        >
          {(
            [
              ['pl', ACCOUNTING_TITLES.profit_loss],
              ['bs', ACCOUNTING_TITLES.balance_sheet],
              ['tb', ACCOUNTING_TITLES.trial_balance],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger key={value} value={value} className={TAB_CLASS}>
              {bi(label)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="pl">
          <ProfitLossPanel />
        </TabsContent>
        <TabsContent value="bs">
          <BalanceSheetPanel />
        </TabsContent>
        <TabsContent value="tb">
          <TrialBalancePanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
