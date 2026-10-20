# Development license signing key — NOT SECRET, NOT FOR PRODUCTION

`license-dev-2026.private.pem` signs on-prem license files for local development and QA. Its
public key is embedded in `src/core/license-keys.ts` with `dev_only: true`, and **licenses signed
by a dev-only key are rejected when `NODE_ENV=production`**.

Release process for the vendor:

1. Generate the production keypair once, offline: `pnpm --filter @kadai/server issue-license keygen --out <safe dir> --kid prod-2026`.
2. Keep the private key in the vendor's secret store (never in this repository).
3. Add the public key to `LICENSE_PUBLIC_KEYS` in `src/core/license-keys.ts` (`dev_only: false`).
4. Sign customer licenses with `issue-license sign --key <private.pem> --kid prod-2026 …`.

Example (development):

```bash
pnpm --filter @kadai/server issue-license sign \
  --key scripts/dev-keys/license-dev-2026.private.pem --kid dev-2026 \
  --licensee "Murugan Stores" --business-name "Murugan Stores" --plan pro --max-stores 1 \
  --valid-from 2026-10-01 --valid-until 2027-09-30 --out /tmp/license.json
```
