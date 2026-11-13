// api/enroll-complete.js
// success_url for /api/enroll. Runs the same idempotent finalization as the
// webhook (fast path), then shows the existing success page. The webhook is
// the reliable path; this only makes the result visible immediately.

import { siteUrlFromRequest, finalizeIntroSubscription, stripeGet } from './_intro-billing.js';

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
    const s = await stripeGet('checkout/sessions/' + encodeURIComponent(sessionId), STRIPE_SECRET_KEY);
    const subId = s.ok && s.data.status === 'complete' && s.data.subscription;
    if (subId) console.log('enroll-complete', JSON.stringify(await finalizeIntroSubscription(subId, STRIPE_SECRET_KEY)));
  } catch (err) {
    console.error('enroll-complete error', err);
  }

  // Payment is already done; always show the success page.
  res.writeHead(303, { Location: successPage });
  res.end();
}
