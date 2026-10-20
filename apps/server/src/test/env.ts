/** Test database URLs (TEST_DATABASE_URL / TEST_DATABASE_SYSTEM_URL, defaulting to kadai_test). */
export function testDatabaseUrls(env: NodeJS.ProcessEnv = process.env): {
  url: string
  systemUrl: string
  appRole: string
} {
  return {
    url: env.TEST_DATABASE_URL || 'postgres://kadai_app:kadai_app@localhost:5432/kadai_test',
    systemUrl:
      env.TEST_DATABASE_SYSTEM_URL ||
      'postgres://kadai_owner:kadai_owner@localhost:5432/kadai_test',
    appRole: env.DATABASE_APP_ROLE || 'kadai_app',
  }
}
