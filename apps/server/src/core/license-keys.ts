/**
 * Ed25519 public keys trusted to sign on-prem license files (ARCHITECTURE.md §17).
 * `dev_only` keys are rejected when NODE_ENV=production. The vendor adds its production key here
 * at release time (see apps/server/scripts/dev-keys/README.md). KADAI_LICENSE_PUBLIC_KEY, when
 * set, replaces this list entirely (testing, private deployments).
 */
export interface LicensePublicKey {
  kid: string
  pem: string
  dev_only: boolean
}

export const LICENSE_PUBLIC_KEYS: readonly LicensePublicKey[] = [
  {
    kid: 'dev-2026',
    dev_only: true,
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgnK/qrtk3dQUcZuQgedQNWvnw6E8IiiDqMe+q/X39JU=
-----END PUBLIC KEY-----
`,
  },
]
