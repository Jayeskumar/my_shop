/**
 * OpenAPI document & Swagger UI at /api/docs (ARCHITECTURE.md §7.1 step 6): enabled outside
 * production, or in production with KADAI_API_DOCS=true. Schemas come from the zod route schemas
 * (fastify-type-provider-zod jsonSchemaTransform). Must be registered before the routes.
 */
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import { jsonSchemaTransform } from 'fastify-type-provider-zod'
import type { Config } from '../config'

export const API_DOCS_PREFIX = '/api/docs'

export async function registerSwagger(
  app: FastifyInstance,
  config: Config,
  version: string,
): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Kadai API',
        description:
          'Kadai (கடை) retail ERP — REST API v1. Conventions: docs/ARCHITECTURE.md §7.3, paths: docs/API.md.',
        version,
      },
      servers: [{ url: config.publicBaseUrl }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
    },
    transform: jsonSchemaTransform,
  })
  const https = config.publicBaseUrl.startsWith('https://')
  await app.register(swaggerUi, {
    routePrefix: API_DOCS_PREFIX,
    staticCSP: true,
    transformStaticCSP: (header) => {
      // Swagger UI sets inline styles (scripts stay 'self' only); no remote stylesheets needed.
      const csp = header.replace(/style-src [^;]*/, "style-src 'self' 'unsafe-inline'")
      // Plain-http (LAN / dev) installs must not upgrade asset requests to https.
      return https ? csp : csp.replace(/\s*upgrade-insecure-requests;?/, '')
    },
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: false },
  })
}
