/**
 * Server CLI entry point: `node dist/cli.js <command> [args]` (dev: `pnpm --filter @kadai/server
 * cli <command>`). Commands = core commands (cli/commands.ts) + every module's `cliCommands`
 * (e.g. the platform module's on-prem `backup`).
 */
import { CORE_COMMANDS } from './cli/commands'
import type { CliCommand, CliIo } from './cli/types'
import { ConfigError } from './config'
import { MODULES } from './modules'

function commandMap(): Map<string, CliCommand> {
  const map = new Map(Object.entries(CORE_COMMANDS))
  for (const m of MODULES) {
    for (const [name, cmd] of Object.entries(m.cliCommands ?? {})) {
      if (map.has(name)) throw new Error(`CLI command "${name}" of module ${m.name} clashes with an existing command`)
      map.set(name, cmd)
    }
  }
  return map
}

const io: CliIo = {
  log: (m) => console.error(m),
  out: (m) => process.stdout.write(`${m}\n`),
}

async function main(argv: string[]): Promise<number> {
  const commands = commandMap()
  const [name, ...args] = argv
  const cmd = name ? commands.get(name) : undefined
  if (!cmd) {
    io.log('Usage: kadai <command> [options]\n\nCommands:')
    const width = Math.max(...[...commands.keys()].map((k) => k.length))
    for (const [n, c] of [...commands.entries()].sort(([a], [b]) => a.localeCompare(b))) io.log(`  ${n.padEnd(width)}  ${c.summary}`)
    return name && name !== 'help' && name !== '--help' ? 64 : 0
  }
  return cmd.run(args, io)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
