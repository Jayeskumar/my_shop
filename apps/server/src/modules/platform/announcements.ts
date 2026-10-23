/**
 * In-app announcements & offer banners for cloud tenants (GET /announcements,
 * POST /announcements/:id/dismiss).
 *
 * Announcements and offers live in the vendor tables (migration 0010, system pool only);
 * dismissals are per-tenant in announcement_dismissals (migration 1000).
 */
import type { AnnouncementSeverity } from '@kadai/shared'
import {
  AnnouncementAudienceSchema,
  type AnnouncementLike,
  type BannerOfferLike,
  OfferBannerSchema,
  selectBanners,
} from '@kadai/shared/api/licensing'
import type { platformRoutes } from '@kadai/shared/api/platform'
import { AppError, notFound } from '../../core/errors'
import type { RouteImpls } from '../../core/http'
import { loadBannerOffers, loadBuyer, pricingBuyer } from './catalog'
import type { PlatformRuntime } from './runtime'

type Routes = typeof platformRoutes

export function announcementHandlers(
  rt: PlatformRuntime,
): Pick<RouteImpls<Routes>, 'announcements' | 'dismissAnnouncement'> {
  const { deps } = rt
  return {
    announcements: {
      tx: async (tx, req) => {
        const now = rt.now()
        const tenantId = req.ctx.tenantId
        // systemDb: announcements and offers are vendor tables without tenant_id.
        const [buyer, ent, rawAnnouncements, offers, dismissals] = await Promise.all([
          loadBuyer(deps.db.systemDb, tenantId),
          deps.entitlements.get(tenantId),
          deps.db.systemDb
            .selectFrom('announcements')
            .select([
              'id',
              'severity',
              'title_en',
              'title_ta',
              'body_en',
              'body_ta',
              'cta_label_en',
              'cta_label_ta',
              'cta_url',
              'offer_id',
              'audience',
              'starts_at',
              'ends_at',
              'is_active',
            ])
            .where('is_active', '=', true)
            .execute(),
          loadBannerOffers(deps.db.systemDb, tenantId, now),
          tx
            .selectFrom('announcement_dismissals')
            .select('banner_id')
            .where('tenant_id', '=', tenantId)
            .execute(),
        ])

        const announcements: AnnouncementLike[] = rawAnnouncements.map((a) => {
          const aud = AnnouncementAudienceSchema.safeParse(a.audience)
          return {
            id: a.id,
            severity: a.severity as AnnouncementSeverity,
            title_en: a.title_en,
            title_ta: a.title_ta,
            body_en: a.body_en,
            body_ta: a.body_ta,
            cta_label_en: a.cta_label_en,
            cta_label_ta: a.cta_label_ta,
            cta_url: a.cta_url,
            offer_id: a.offer_id,
            audience: aud.success ? aud.data : {},
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            is_active: a.is_active,
          }
        })

        const bannerOffers: BannerOfferLike[] = offers.map((o) => {
          const parsed = OfferBannerSchema.safeParse(o.banner)
          return {
            ...o,
            banner: parsed.success ? parsed.data : null,
          }
        })

        const pb = pricingBuyer(buyer)
        const banners = selectBanners({
          announcements,
          offers: bannerOffers,
          target: {
            channel: 'cloud',
            business_type: pb.business_type,
            state_code: pb.state_code,
            plan_code: ent.plan_code,
            segments: pb.segments,
          },
          now,
          dismissed_ids: dismissals.map((d) => d.banner_id),
        })

        return { data: banners }
      },
    },

    dismissAnnouncement: {
      tx: async (tx, req) => {
        const bannerId = req.params.id
        // systemDb: check whether the id belongs to an announcement or offer in the vendor tables.
        const [ann, offer] = await Promise.all([
          deps.db.systemDb
            .selectFrom('announcements')
            .select(['id', 'severity'])
            .where('id', '=', bannerId)
            .executeTakeFirst(),
          deps.db.systemDb
            .selectFrom('offers')
            .select('id')
            .where('id', '=', bannerId)
            .executeTakeFirst(),
        ])
        if (!ann && !offer) throw notFound('announcement', bannerId)
        if (ann?.severity === 'critical') {
          throw new AppError('CONFLICT', 'Critical announcements cannot be dismissed', {
            reason: 'not_dismissible',
          })
        }
        const source = ann ? 'announcement' : 'offer'
        await tx
          .insertInto('announcement_dismissals')
          .values({
            tenant_id: req.ctx.tenantId,
            banner_id: bannerId,
            source,
            dismissed_by: req.ctx.userId,
            dismissed_at: rt.now(),
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'banner_id']).doNothing())
          .execute()
      },
    },
  }
}
