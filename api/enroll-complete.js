// api/enroll-complete.js
// success_url for /api/enroll. Runs the same idempotent finalization as the
// webhook (fast path), then shows the existing success page. The webhook is
// the reliable path; this only makes the result visible immediately.
// Legacy intro-15 sessions (opened before this release) are still finalized.

import { siteUrlFromRequest, finalizeIntroSubscription, stripeGet } from './_intro-billing.js';
import { finalizeEditionSubscription } from './_billing.js';

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url || '/', 'https://placeholder.local');
  const sessionId = url.searchParams.get('session_id') || '';
  let successPage = SITE_URL + '/les-essais/success.html?session_id=' + encodeURIComponent(sessionId);

  try {
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Missing or invalid session_id');
    const s = await stripeGet('checkout/sessions/' + encodeURIComponent(sessionId), STRIPE_SECRET_KEY);
    const subId = s.ok && s.data.status === 'complete' && s.data.payment_status === 'paid' && s.data.subscription;
    if (s.ok && s.data.metadata && s.data.metadata.offer === 'intro-15') successPage += '&offer=intro';
    if (subId) {
      let result = await finalizeEditionSubscription(subId, STRIPE_SECRET_KEY);
      if (result.status === 'ignored') result = await finalizeIntroSubscription(subId, STRIPE_SECRET_KEY);
      console.log('enroll-complete', JSON.stringify(result));
    }
  } catch (err) {
    console.error('enroll-complete error', err);
  }

  // Payment is already done; always show the success page.
  res.writeHead(303, { Location: successPage });
  res.end();
}
