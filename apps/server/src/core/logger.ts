/**
 * Structured JSON logging with pino (ARCHITECTURE.md §7.8): request id on every request line,
 * redaction of credentials, pretty output only in development.
 */
import pino, { type Logger, type LoggerOptions } from 'pino'
import type { Config } from '../config'

export type { Logger } from 'pino'

const SECRET_KEYS = [
  'password',
  'new_password',
  'current_password',
  'pin',
  'otp',
  'otp_code_hash',
  'credentials',
  'refresh_token',
  'access_token',
  'device_secret',
  'key_secret',
  'webhook_secret',
  'secret',
  'api_key',
]

/** Redaction paths: headers + secret-looking fields up to three levels deep. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
]

export function loggerOptions(
  config: Pick<Config, 'logLevel' | 'logPretty' | 'mode'>,
  version: string,
): LoggerOptions {
  const opts: LoggerOptions = {
    level: config.logLevel,
    base: { app: 'kadai', mode: config.mode, version },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  }
  if (config.logPretty) {
    // pino-pretty is a dev dependency: only used when explicitly pretty (development on a TTY).
    opts.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,app,mode,version' },
    }
  }
  return opts
}

export function createLogger(
  config: Pick<Config, 'logLevel' | 'logPretty' | 'mode'>,
  version: string,
): Logger {
  return pino(loggerOptions(config, version))
}
