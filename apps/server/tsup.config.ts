import { defineConfig } from 'tsup'

// Production bundle: one ESM file per entry point (shared code split into chunks).
// @kadai/shared is TypeScript source inside the monorepo, so it is bundled; so is `uuid`, its
// only runtime dependency the server does not declare itself. Everything else stays external and
// is resolved from apps/server/node_modules at runtime.
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    migrate: 'src/db/migrate-cli.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  noExternal: [/^@kadai\//, 'uuid'],
})
