/**
 * Vendor CLI: `pnpm --filter @kadai/server issue-license keygen|sign|verify …`
 * (see apps/server/scripts/dev-keys/README.md and src/cli/license-cli.ts).
 */
import { runLicenseCli } from '../src/cli/license-cli'

runLicenseCli(process.argv.slice(2), {
  log: (m) => console.error(m),
  out: (m) => process.stdout.write(`${m}\n`),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
