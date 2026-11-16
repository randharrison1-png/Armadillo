import 'server-only';
import { z } from 'zod';
import { withAnon } from '@/server/db/withUser';
import { checkRateLimit, REPORT_LIMIT } from '@/server/security/rateLimit';
import { slugSchema } from './schema';

export const REASON_MAX = 2000;
export const reportSchema = z.object({
  slug: slugSchema,
  reason: z.string().trim().min(1, 'Tell us what is wrong with this paste.').max(REASON_MAX, `Use ${REASON_MAX} characters or fewer.`),
});
export type ReportInput = z.input<typeof reportSchema>;

export type ReportOutcome = { status: 'stored' } | { status: 'not_found' } | { status: 'rate_limited'; retryAfter: number };

/**
 * Stores an abuse report for a live paste. Works signed out (role anon). The reporter is only a
 * pseudonymous hash (see reporterHash), rate-limited to 5 reports/hour. Refusals RETURN instead
 * of throwing, so the attempt stays counted: probing for slugs or hammering past the limit is
 * itself rate-limited.
 */
export async function reportPasteFor(input: ReportInput, reporterHash: string): Promise<ReportOutcome> {
  const r = reportSchema.parse(input);
  return withAnon(async (tx): Promise<ReportOutcome> => {
    const rate = await checkRateLimit(tx, `report:${reporterHash}`, REPORT_LIMIT.limit, REPORT_LIMIT.windowSec);
    if (!rate.ok) return { status: 'rate_limited', retryAfter: rate.retryAfter };
    // anon can read live pastes only (RLS), so a deleted or expired paste is "not found" here.
    const live = await tx`select 1 from paste.pastes where slug = ${r.slug}`;
    if (live.length === 0) return { status: 'not_found' };
    await tx`insert into paste.reports (paste_slug, reason, reporter_hash) values (${r.slug}, ${r.reason}, ${reporterHash})`;
    return { status: 'stored' };
  });
}
