/**
 * Server CLI command contract (`node dist/cli.js <command> [args]`, `pnpm --filter @kadai/server
 * cli <command>`). Core commands live in cli/commands.ts; modules contribute their own through
 * `cliCommands` in their module definition (e.g. the platform module's `backup`).
 */
export interface CliIo {
  /** Human-readable output (stderr, so stdout stays clean for machine output). */
  log(message: string): void
  /** Machine-readable output (stdout). */
  out(message: string): void
}

export interface CliCommand {
  /** One-line description for `help`. */
  summary: string
  usage?: string
  /** Returns the process exit code. */
  run(args: string[], io: CliIo): Promise<number>
}
