// api/enroll-complete.js
// success_url for /api/enroll. Makes sure the first renewal ($34) lands on the
// next calendar 1st after enrollment, then shows the existing success page.
// Only needed when Checkout's 48-hour trial minimum pushed the trial past the
// 1st (signups in the last ~2 days of a month). Idempotent and safe to repeat.

import { INTRO_OFFER, businessTimeZone, siteUrlFromRequest, nextFirst, stripeGet, stripePost } from './_intro-billing.js';

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url || '/', 'https://placeholder.local');
  const sessionId = url.searchParams.get('session_id') || '';
  const successPage = SITE_URL + '/les-essais/success.html?offer=intro&session_id=' + encodeURIComponent(sessionId);

  try {
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Missing or invalid session_id');

    const s = await stripeGet('checkout/sessions/' + encodeURIComponent(sessionId) + '?expand[]=subscription', STRIPE_SECRET_KEY);
    const session = s.ok && s.data;
    const sub = session && session.subscription;
    const isIntro = session && session.metadata && session.metadata.offer === INTRO_OFFER;

    if (isIntro && session.status === 'complete' && sub && sub.status === 'trialing') {
      const target = nextFirst(new Date(), businessTimeZone()).unix;
      const nowSec = Math.floor(Date.now() / 1000);
      if (sub.trial_end !== target && target > nowSec + 60) {
        const body = new URLSearchParams();
        body.append('trial_end', String(target));
        body.append('proration_behavior', 'none');
        const u = await stripePost('subscriptions/' + sub.id, body, STRIPE_SECRET_KEY,
          'les-essais-enroll-complete-' + sub.id + '-' + target);
        if (!u.ok) console.error('enroll-complete: trial_end update failed', sub.id, u.data);
        else console.log('enroll-complete: first renewal set to', target, 'for', sub.id);
      }
    }
  } catch (err) {
    console.error('enroll-complete error', err);
  }

  // Payment is already done; always show the success page.
  res.writeHead(303, { Location: successPage });
  res.end();
}
