/**
 * Password & PIN hashing (ARCHITECTURE.md §7.4, §17): argon2id with m=19456 KiB, t=2, p=1
 * (OWASP baseline). PINs are short, so their real protection is the 5-attempt lockout; hashing
 * them with argon2id still makes an offline database leak expensive to brute-force.
 */
import { type Algorithm, hash, verify } from '@node-rs/argon2'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@kadai/shared/api/auth'
import type { ValidationIssue } from '@kadai/shared'
import { validationError } from './errors'

// `Algorithm` is an ambient const enum (not importable as a value with verbatimModuleSyntax):
// 2 = Algorithm.Argon2id.
const ARGON2ID = 2 as Algorithm

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize('NFC'), ARGON2_PARAMS)
}

/** Verifies a password; malformed hashes count as a mismatch (never throws for bad input). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password.normalize('NFC'))
  } catch {
    return false
  }
}

// A fixed hash so that "user not found" costs the same time as "wrong password".
let dummyHash: Promise<string> | null = null

/**
 * Verifies against `passwordHash`, or burns an equivalent argon2 computation when the account
 * does not exist / has no password — prevents user enumeration through response timing.
 */
export async function verifyPasswordOrDummy(
  passwordHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (passwordHash) return verifyPassword(passwordHash, password)
  dummyHash ??= hashPassword('kadai-dummy-password-for-timing')
  await verifyPassword(await dummyHash, password)
  return false
}

/** True when the hash was produced with weaker/other parameters and should be upgraded on login. */
export function needsRehash(passwordHash: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash)
  if (!m) return true
  return (
    Number(m[1]) !== ARGON2_PARAMS.memoryCost ||
    Number(m[2]) !== ARGON2_PARAMS.timeCost ||
    Number(m[3]) !== ARGON2_PARAMS.parallelism
  )
}

export const PIN_RE = /^\d{4,6}$/

export async function hashPin(pin: string): Promise<string> {
  if (!PIN_RE.test(pin))
    throw validationError([{ path: 'pin', message: 'PIN must be 4 to 6 digits' }])
  return hash(pin, ARGON2_PARAMS)
}

export function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  if (!PIN_RE.test(pin)) return Promise.resolve(false)
  return verifyPassword(pinHash, pin)
}

/** PINs that are trivially guessed at a counter. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true // 1111, 000000
  const asc = '01234567890'
  const desc = '09876543210'
  return asc.includes(pin) || desc.includes(pin) // 1234, 4321, 123456
}

// Small deny-list of the most common passwords (top of public breach corpora, incl. Indian ones).
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  '11111111',
  '00000000',
  '87654321',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'abc12345',
  'abcd1234',
  'admin123',
  'welcome1',
  'welcome123',
  'india123',
  'india@123',
  'chennai123',
  'kadai123',
  'shop1234',
  'letmein1',
  'sunshine',
  'football',
  'baseball',
  'princess',
  'superman',
  'computer',
  'internet',
  'whatever',
  'trustno1',
])

export interface PasswordContext {
  phone?: string | null
  email?: string | null
  name?: string | null
}

/**
 * Password policy beyond length (8–128, enforced by the shared PasswordSchema): not a common
 * password, not only one repeated character, does not contain the user's phone number or the
 * local part of their email. Returns the issues (empty = acceptable).
 */
export function passwordPolicyIssues(
  password: string,
  who: PasswordContext = {},
  path = 'password',
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const p = password.normalize('NFC')
  const lower = p.toLowerCase()
  if (p.length < PASSWORD_MIN_LENGTH)
    issues.push({
      path,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      code: 'too_short',
    })
  if (p.length > PASSWORD_MAX_LENGTH)
    issues.push({ path, message: 'Password is too long', code: 'too_long' })
  if (/^(.)\1*$/su.test(p))
    issues.push({ path, message: 'Password cannot be one repeated character', code: 'repeated' })
  if (COMMON_PASSWORDS.has(lower))
    issues.push({ path, message: 'This password is too common', code: 'common' })
  const digits = who.phone?.replace(/\D/g, '').slice(-10)
  if (digits && digits.length === 10 && p.replace(/\D/g, '').includes(digits)) {
    issues.push({
      path,
      message: 'Password must not contain your mobile number',
      code: 'contains_phone',
    })
  }
  const local = who.email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && lower.includes(local)) {
    issues.push({
      path,
      message: 'Password must not contain your email name',
      code: 'contains_email',
    })
  }
  return issues
}

/** Throws VALIDATION_ERROR when the password violates the policy. */
export function assertPasswordPolicy(
  password: string,
  who: PasswordContext = {},
  path = 'password',
): void {
  const issues = passwordPolicyIssues(password, who, path)
  if (issues.length) throw validationError(issues, issues[0]!.message)
}
