export const meta = {
  name: 'kadai-integrate',
  description: 'Kadai integration: serial module merges with full checks, then E2E suite, multi-lens audits with verification, fixes and release readiness',
  phases: [
    { title: 'Merge', detail: 'merge each module branch serially into the integration branch; full checks; fix integration issues' },
    { title: 'E2E', detail: 'Playwright end-to-end suites per vertical, demo seed data, fixes' },
    { title: 'Audit', detail: 'parallel read-only audits by lens' },
    { title: 'Verify', detail: 'adversarial verification of each audit finding' },
    { title: 'Fix', detail: 'area-batched fixes of confirmed findings' },
    { title: 'Release', detail: 'final full verification, docs, push' },
  ],
}

// args: { stage: 'merge' | 'harden', order?: string[], crossModule?: Record<string,string>, notes: string }
const STAGE = (args && args.stage) || 'merge'
const NOTES = (args && args.notes) || ''
const MAIN = '/home/user/my_shop'
const BRANCH = 'claude/laughing-hamilton-cleqkb'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R9SwozABHzZsWcbEK6M9h1`

const COMMON = `
You are a senior engineer on the team building "Kadai" (கடை): an enterprise-grade vertical retail ERP for Indian — especially Tamil Nadu — small shops (general stores, supermarkets, apparel, pharmacies, …), shipped from ONE codebase as multi-tenant cloud SaaS and single-tenant on-prem. Production software.
You work in the integration checkout ${MAIN} on branch ${BRANCH}. Contract docs: docs/ARCHITECTURE.md, docs/API.md, docs/PRODUCT.md; schema apps/server/migrations/*.sql; contracts packages/shared/src/api/*.ts.
Project notes:
${NOTES}
RESUMING: the machine restarts occasionally and kills running agents; files survive. FIRST inspect git status/diff/log in ${MAIN} and continue any half-done work of your task instead of redoing it. If PostgreSQL/Redis are down, start them: pg_ctlcluster 16 main start; redis-server --daemonize yes.
Rules: serialize pnpm installs with flock /tmp/kadai-pnpm.lock; never skip/disable tests to get green — fix root causes; keep servers in the background and kill them when done; strict TypeScript; Tamil + English for every user-visible string. Commit with descriptive messages ending with exactly:
${TRAILER}
Never push unless your task says so. Never rewrite history.
`

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verification: { type: 'string' },
    fixes: { type: 'string', description: 'integration fixes made (file: what/why)' },
    open_issues: { type: 'string', description: 'remaining problems you could not fix' },
  },
  required: ['summary', 'verification', 'fixes', 'open_issues'],
}

if (STAGE === 'merge') {
  const order = (args && args.order) || ['catalog', 'parties', 'identity', 'inventory', 'payments', 'accounting', 'purchases', 'sales', 'notifications', 'platform', 'licensing', 'reports', 'onprem']
  const cross = (args && args.crossModule) || {}
  phase('Merge')
  const out = []
  for (const key of order) {
    const r = await agent(`${COMMON}
YOUR TASK: merge module branch mod/${key} (built and reviewed in worktree /home/user/wt/${key}) into ${BRANCH} in ${MAIN}, then make the integrated repo fully green.
Steps:
1) git -C ${MAIN} status must be clean (commit or report anything unexpected). git merge --no-ff mod/${key} -m "Merge module ${key}" (append the trailer lines to the message).
2) Resolve conflicts preserving both sides' intent. Generated files: pnpm-lock.yaml → re-run flock /tmp/kadai-pnpm.lock pnpm install and take the result; apps/server/src/db/schema.generated.ts → pnpm db:migrate (dev DB 'kadai') then pnpm db:types; i18n JSON → union of keys; route/nav registries → keep all entries.
3) Run: flock /tmp/kadai-pnpm.lock pnpm install --frozen-lockfile (or plain install if the lockfile legitimately changed), pnpm db:migrate, pnpm db:types (must be a no-op diff or commit the regeneration), pnpm lint, pnpm typecheck, pnpm test (ALL packages; the server suite runs against kadai_test), pnpm build. Fix every failure — integration problems between modules are your job now (e.g. two modules touched a shared file, a frontend calls another module's endpoint that differs from its contract, missing exports used across modules). Prefer fixing the caller to match the contract; change a contract only when it is wrong, and then fix both sides.
4) Cross-module follow-ups reported by this module's build/review agents (apply the ones whose counterpart module is already merged; leave a precise note for the others in docs/INTEGRATION_NOTES.md under the counterpart module's heading so the later merge can finish them; also check that file for notes addressed TO ${key} from earlier merges and complete them now):
${cross[key] || '(none reported)'}
5) Smoke: build the web, start the server (KADAI_SERVE_WEB=true) in the background on port 8080 against the dev DB, curl /health/ready and the main GET endpoints of ${key} with a freshly signed-up tenant (curl signup), then kill it.
6) Commit the merge (and fix commits) with the trailer. Remove the worktree afterwards: git -C ${MAIN} worktree remove /home/user/wt/${key} --force (keep the branch), and drop its databases: PGPASSWORD=kadai_owner dropdb -h localhost -U kadai_owner --if-exists kadai_dev_${key}; same for kadai_test_${key}.
Report what you merged, fixed, and anything still open.`, { label: `merge:${key}`, phase: 'Merge', schema: REPORT })
    out.push({ key, ...(r || { summary: 'FAILED', verification: '', fixes: '', open_issues: 'merge agent failed' }) })
    log(`merged ${key}: ${r ? 'ok' : 'FAILED'}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// STAGE harden: E2E → audits → verify → fix → release
// ---------------------------------------------------------------------------
phase('E2E')
const e2e = await agent(`${COMMON}
YOUR TASK: end-to-end quality of the fully integrated product.
1) Demo/seed data: add apps/server/src/scripts/seed-demo.ts (pnpm --filter @kadai/server seed:demo -- --vertical=general_store|supermarket|apparel|pharmacy --phone=...) that creates a realistic Tamil Nadu tenant through the real services (onboarding, catalog, purchases, sales, payments): 60–150 products with Tamil names, suppliers, customers with khata dues, 30 days of sales history incl. UPI/cash/credit, returns, expenses, shifts. Idempotent per phone. Document in README.
2) Playwright E2E suite in apps/web/e2e/ (playwright.config.ts using chromium at /opt/pw-browsers via executablePath, webServer that builds & starts the API with KADAI_SERVE_WEB=true against a dedicated database kadai_e2e (create/migrate it in globalSetup), KADAI_ENABLE_MOCK_PAYMENTS=true): specs per vertical —
   general_store: signup (Tamil UI) → add products incl. loose rice by kg → purchase bill entry → POS sale cash with change → khata credit sale → receive payment from the customer page → day close (shift) ;
   supermarket: scale barcode sale, promotion buy-2-get-1, split payment cash+UPI (mock dynamic intent paid via mock-pay), hold & recall bill, offline mode (context.setOffline(true)) sale queued + sync after reconnect with the right invoice number;
   apparel: variant matrix creation, label print page renders barcodes, sale of a ₹2,800 shirt (18%) and a ₹999 shirt (5%), exchange via return + new sale;
   pharmacy: batch & expiry purchase, FEFO pick at POS, Schedule H1 drug requires Rx dialog, expired batch blocked, H1 register report shows the sale, loose tablets from a strip;
   ON-PREM FIRST (our primary segment — the most thorough specs): KADAI_MODE=onprem server + a separate vendor-console server (KADAI_MODE=cloud, KADAI_VENDOR_CONSOLE=true, own database) on another port: setup wizard → issue a license in the vendor console (staff) → activate online in the shop app → check-in shows an offer banner → renewal checkout with a coupon (mock Razorpay) → refreshed license with extended AMC → offline activation round trip on a second shop install → update center: publish a release in the vendor console, shop sees it, requests install (host updater simulated by a test helper that writes status.json) → backup now + external folder copy + restore request → Kadai Connect: owner OTP login on the vendor /connect page sees the shop's snapshot → counters on the LAN (two browser contexts as two registers) billing simultaneously with gapless per-register numbering → messaging relay sends a WhatsApp invoice share through the vendor (log provider);
   cross-cutting: GSTR-1 JSON download for the period has the expected sections, role-restricted cashier cannot see reports/settings, language toggle persists, on-prem setup wizard (second webServer with KADAI_MODE=onprem on another port + database) .
   Add a pnpm script "e2e" in apps/web and a CI job (in .github/workflows/ci.yml) that runs it with a Postgres service.
3) Run the suite; every failure is either a test bug or a product bug — fix product bugs at the root cause anywhere in the repo (commit in logical chunks). Keep screenshots of key screens into /tmp/kadai-shots/e2e/ and Read a sample of them to catch visual issues (Tamil text overflow, broken layouts on 390px).
4) Performance smoke: seed a supermarket with 20,000 products; measure GET /pos/bootstrap time & payload, product lookup p95, POST /sales/invoices p95 for a 15-line bill (autocannon via npx or a small node script) — target ≤100 ms p95 for lookup/save on this machine; add indexes/optimizations where needed; record numbers in docs/PERFORMANCE.md.
All green at the end: pnpm lint, typecheck, test, build, e2e.`, { label: 'e2e+seed+perf', phase: 'E2E', schema: REPORT })

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short slug' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          area: { type: 'string', description: 'module or layer' },
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'code excerpt / reproduction steps proving it' },
          fix: { type: 'string', description: 'concrete fix proposal' },
        },
        required: ['id', 'severity', 'area', 'file', 'title', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const LENSES = [
  { key: 'security', prompt: 'SECURITY: authn/authz on every route (permission + feature + store scope), tenant isolation (any systemDb use outside justified flows, raw SQL without tenant filter, RLS bypass, composite FK gaps), IDOR on ids in params/bodies (ids of another tenant or store), injection (sql.raw, ILIKE patterns unescaped, CSV formula injection in exports), secrets handling (credentials returned/logged, encryption usage), webhook signature verification & replay, rate limits on auth/OTP/public endpoints, session/refresh/PIN/device flows, file upload validation & content-type sniffing, SSRF in provider base URLs, XSS in print templates/public invoice/notification rendering (dangerouslySetInnerHTML), CORS/CSP/cookies, error leakage, dependency risks (pnpm audit --prod).' },
  { key: 'money', prompt: 'MONEY, GST & ACCOUNTING CORRECTNESS: every path that computes or posts money — sales pricing (inclusive/exclusive, slab GST, cess, bill discounts, promotions, rounding, round-off), credit notes pro-rata exactness, purchases landed cost & ITC, expenses GST, journal posting rules vs ARCHITECTURE §10 (each document type and its cancellation), party balances, payment allocations & statuses, shift expected cash, loyalty, GSTR-1/3B/HSN aggregation rules (B2CL threshold ₹1,00,000, doc_issue counts, credit note sections, composition), number series gaplessness & FY boundaries (31-Mar → 1-Apr), timezone (IST) date derivation for invoice_date & reports. Write small throwaway scripts/tests to PROVE each finding with concrete numbers.' },
  { key: 'concurrency', prompt: 'CONCURRENCY, IDEMPOTENCY & OFFLINE ROBUSTNESS: race conditions (double posting/cancel, concurrent POS saves on same stock/series/customer, intent paid twice, webhook + poll simultaneous), missing FOR UPDATE locks or lock-order deadlocks, transaction boundaries (side effects outside tx, notifications/jobs enqueued before commit), idempotency keys/client_ref coverage for every financial create, offline POS outbox (ordering, renumbering, duplicates on retry, data loss on refresh/crash, IndexedDB versioning/migrations), SSE reconnection, job retries & poison messages, graceful shutdown.' },
  { key: 'ux-i18n', prompt: 'UX, TAMIL & ACCESSIBILITY: walk every page (start the app with seeded demo data: pnpm --filter @kadai/server seed:demo) in Tamil and English at 1366x768 and 390x844 with Playwright screenshots (Read them): hard-coded English strings, missing/mismatched ta vs en keys (script compare all locale files), unnatural or wrong Tamil, text overflow/truncation of Tamil, inconsistent terminology across modules (bill/invoice, khata/credit), number/date/currency formats (Indian grouping, dd-MM-yyyy, IST), missing empty/loading/error states, keyboard flow on POS & purchase entry, focus management in dialogs, colour contrast, touch target sizes, broken links between modules, console errors.' },
  { key: 'perf-db', prompt: 'PERFORMANCE & DATABASE: N+1 queries, missing indexes for every list filter/sort and report query (EXPLAIN ANALYZE on seeded data), unbounded queries/exports (streaming), large payloads (POS bootstrap delta), pagination totals cost, web bundle size & code splitting (vite build report), unnecessary re-renders on the POS screen, memory leaks (SSE/listeners), pg pool sizing, pg-boss settings, migration safety (locks on big tables).' },
  { key: 'ops-modes', prompt: 'OPERATIONS, ON-PREM & LICENSING (on-prem is the PRIMARY segment — be exhaustive): license activation online/offline, check-in signing/replay protection, grace & read-only behaviour, clone detection, AMC update eligibility, host updater safety (signature verification, rollback, pre-upgrade backup, never losing data), backup/restore correctness & retention, USB/external copies, cloud backup encryption (we must never be able to decrypt), Windows native install/upgrade/uninstall scripts, LAN multi-counter behaviour, offline-forever operation of perpetual licenses, vendor console pricing/GST/invoice numbering & partner scoping. Also cloud vs on-prem parity (every route/job/UI behaves correctly per KADAI_MODE; on-prem setup wizard, license enforcement, backups/restore, embedded worker, local files; cloud signup, billing, platform admin), configuration validation (production guards), Dockerfile/compose/k8s correctness vs actual build outputs & scripts, CI workflow vs package scripts, health/readiness semantics, logging redaction, metrics, docs accuracy (README, DEPLOYMENT, RUNBOOK, ARCHITECTURE, API vs code), upgrade path (migrations on boot, pre-upgrade backup).' },
  { key: 'contracts-errors', prompt: 'API CONTRACTS & ERROR HANDLING: every route in packages/shared/src/api/*.ts route catalogues is implemented with the same method/path/schemas/permission/feature; every docs/API.md endpoint exists; web calls match; error codes used consistently and mapped to localized messages; validation completeness (string lengths, enums, numeric bounds, cross-field rules); status transition guards (cancel twice, edit posted docs); consistent pagination/sort; OpenAPI (/api/docs) generation works and is complete.' },
]

phase('Audit')
const audits = await parallel(LENSES.map((l) => () => agent(`${COMMON}
YOUR TASK: READ-ONLY audit (do not edit tracked files; throwaway scripts only under /tmp) of the integrated codebase through this lens:
${l.prompt}
Report only real, evidenced problems (not style nits), each with file/line, evidence and a concrete fix. Rank by severity. Aim for completeness within the lens — check every module, not just the first few.`, { label: `audit:${l.key}`, phase: 'Audit', schema: FINDINGS })))

const all = audits.filter(Boolean).flatMap((a, i) => a.findings.map((f) => ({ ...f, lens: LENSES[i].key })))
const seen = new Set()
const unique = all.filter((f) => { const k = `${f.file}:${f.line || 0}:${f.title.toLowerCase().slice(0, 40)}`; if (seen.has(k)) return false; seen.add(k); return true })
log(`${all.length} findings, ${unique.length} unique`)

phase('Verify')
const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, reason: { type: 'string' }, refined_fix: { type: 'string' } },
  required: ['real', 'severity', 'reason', 'refined_fix'],
}
const verified = await parallel(unique.filter((f) => f.severity !== 'low').map((f) => () => agent(`${COMMON}
YOUR TASK: adversarially verify this audit finding (READ-ONLY; throwaway scripts under /tmp allowed, e.g. a quick test proving it). Try hard to REFUTE it: is the code path reachable from a real caller, does another layer already prevent it, is the evidence misread? Default to real=false if you cannot demonstrate it.
FINDING (${f.lens}/${f.severity}) ${f.title}
File: ${f.file}:${f.line || ''}
Evidence: ${f.evidence}
Proposed fix: ${f.fix}`, { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT, effort: 'medium' }).then((v) => (v ? { ...f, verdict: v } : null))))
const confirmed = verified.filter(Boolean).filter((f) => f.verdict.real)
const lows = unique.filter((f) => f.severity === 'low')
log(`${confirmed.length} confirmed (+${lows.length} low-severity passed straight to fixers)`)

phase('Fix')
const byArea = {}
for (const f of [...confirmed, ...lows]) { const k = f.lens; (byArea[k] = byArea[k] || []).push(f) }
const fixReports = []
for (const [lens, items] of Object.entries(byArea)) {
  const r = await agent(`${COMMON}
YOUR TASK: fix these confirmed findings (lens: ${lens}). For each: implement the fix at the root cause, add a regression test where testable, keep changes minimal and consistent with the architecture. Then run pnpm lint, typecheck, test, build (and the e2e suite: pnpm --filter @kadai/web e2e) — all green — and commit in logical chunks.
${items.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — ${f.file}:${f.line || ''}\n   evidence: ${f.evidence}\n   fix: ${(f.verdict && f.verdict.refined_fix) || f.fix}`).join('\n')}
In your report list each finding number with fixed / not-fixed (+why).`, { label: `fix:${lens}`, phase: 'Fix', schema: REPORT })
  fixReports.push({ lens, ...(r || { summary: 'FAILED', verification: '', fixes: '', open_issues: 'fix agent failed' }) })
}

phase('Release')
const release = await agent(`${COMMON}
YOUR TASK: release readiness.
1) Full verification from a clean state: rm -rf node_modules/.cache dist folders; flock pnpm install --frozen-lockfile; pnpm lint; pnpm typecheck; pnpm test; pnpm build; pnpm --filter @kadai/web e2e. All green.
2) Docs: README.md (product overview, screenshots from /tmp/kadai-shots copied into docs/screenshots/ (a handful, optimized PNG), quick start, demo seed, architecture), docs/ARCHITECTURE.md & docs/API.md reflect the code (diff route catalogues vs API.md), docs/DEPLOYMENT.md & RUNBOOK.md accurate, docs/USER_GUIDE.ta.md — a concise Tamil user guide for shop owners (setup, billing, UPI, khata, purchases, GST returns, backups), CHANGELOG.md (v1.0.0 features by module).
3) git log sanity; commit; then push: git push -u origin ${BRANCH} (retry up to 4 times with exponential backoff 2s/4s/8s/16s only on network errors).
Report the final state (test counts, e2e results, performance numbers) and any open issues honestly.`, { label: 'release', phase: 'Release', schema: REPORT })

return { e2e, audits_total: all.length, unique: unique.length, confirmed: confirmed.map((f) => ({ id: f.id, lens: f.lens, severity: f.verdict.severity, title: f.title })), fixReports, release }
