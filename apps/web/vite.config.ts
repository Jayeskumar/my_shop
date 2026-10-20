import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/** API server used by `vite dev` / `vite preview` (the Fastify server, see apps/server). */
const apiTarget = process.env.KADAI_API_URL ?? 'http://localhost:8080'

// Everything the server owns is proxied; the rest is the SPA. A regex key so that e.g.
// `/publicity` is not swallowed by the `/public` prefix.
const proxy: Record<string, ProxyOptions> = {
  '^/(api|webhooks|public|health)(/|$)': {
    target: apiTarget,
    changeOrigin: false,
    // SSE streams (payment intents) must not be buffered or timed out by the proxy.
    timeout: 0,
    proxyTimeout: 0,
  },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered explicitly in src/app/pwa.ts
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'robots.txt'],
      manifest: {
        id: '/',
        name: 'Kadai — கடை',
        short_name: 'Kadai',
        description:
          'Billing, stock, GST and UPI for Tamil Nadu shops — பில்லிங், சரக்கு, GST, UPI ஒரே இடத்தில்',
        lang: 'ta',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        theme_color: '#0F766E',
        background_color: '#F8FAFC',
        categories: ['business', 'finance', 'productivity'],
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          {
            name: 'புதிய பில் · New bill',
            short_name: 'புதிய பில்',
            url: '/pos',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
          {
            name: 'விற்பனை · Sales',
            short_name: 'விற்பனை',
            url: '/sales/invoices',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        // App shell + the Latin/Tamil font subsets (other Inter subsets are cached on use).
        globPatterns: [
          '**/*.{js,css,html,svg,png,ico,webmanifest}',
          'assets/*{latin,tamil}*.woff2',
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Server-owned paths must never be answered with the SPA shell.
        navigateFallbackDenylist: [
          /^\/api(\/|$)/,
          /^\/webhooks(\/|$)/,
          /^\/public(\/|$)/,
          /^\/health(\/|$)/,
          /^\/metrics(\/|$)/,
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // The only cached API: the POS catalogue bootstrap, so a counter can open offline.
            // Everything else under /api is network-only (no handler matches it).
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && url.pathname === '/api/v1/pos/bootstrap',
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'kadai-pos-bootstrap',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 8, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'kadai-fonts',
              expiration: { maxEntries: 60, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      onwarn(warning, warn) {
        // Third-party annotation comments Rollup drops (zod's regexes.js): harmless and not ours
        // to fix; keep every other warning visible.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return
        warn(warning)
      },
      output: {
        // Stable vendor chunks: app deploys don't invalidate the cached libraries.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'vendor-react'
          if (id.includes('@radix-ui') || id.includes('cmdk')) return 'vendor-ui'
          if (id.includes('@tanstack')) return 'vendor-tanstack'
          if (id.includes('i18next')) return 'vendor-i18n'
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts'
          if (id.includes('zod') || id.includes('react-hook-form') || id.includes('@hookform'))
            return 'vendor-forms'
          if (id.includes('dexie')) return 'vendor-dexie'
          return undefined
        },
      },
    },
  },
})
