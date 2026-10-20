// Docker HEALTHCHECK for the Kadai image (Kubernetes uses its own HTTP probes instead).
//
// The role is read from PID 1's command line (tini -- kadai-entrypoint <role>):
//   server (default)        GET /health/live on the local port must answer 200
//   worker / migrate / cli  no HTTP listener: a running process is a healthy process
//                           (worker liveness is reported by /health/ready of the API)
import { readFileSync } from 'node:fs'
import http from 'node:http'
import process from 'node:process'

function containerRole() {
  try {
    const argv = readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean)
    const i = argv.findIndex((a) => a.endsWith('kadai-entrypoint'))
    return i >= 0 ? (argv[i + 1] ?? 'server') : 'server'
  } catch {
    return 'server'
  }
}

function probeHost() {
  const host = process.env.HOST ?? ''
  return host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

if (containerRole() !== 'server') process.exit(0)

const req = http.get(
  {
    host: probeHost(),
    port: Number(process.env.PORT ?? 8080),
    path: '/health/live',
    timeout: 4000,
    headers: { 'user-agent': 'kadai-healthcheck' },
  },
  (res) => {
    res.resume()
    process.exit(res.statusCode === 200 ? 0 : 1)
  },
)
req.on('timeout', () => req.destroy(new Error('timeout')))
req.on('error', (err) => {
  process.stderr.write(`healthcheck failed: ${err.message}\n`)
  process.exit(1)
})
