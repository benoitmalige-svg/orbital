// api/membership-price.js
// The price the Les Essais page displays. It is read from the same Stripe price
// that /api/enroll charges (MEMBERSHIP_PRICE_ID), so the page and the checkout
// always show the same amount. Changing the price is done in one place (the
// Vercel STRIPE_RECURRING_PRICE_ID setting); there is no date-based switch.

import { stripeGet } from './_intro-billing.js';
import { MEMBERSHIP_PRICE_ID } from './_billing.js';

export default async function handler(req, res) {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
    const r = await stripeGet('prices/' + encodeURIComponent(MEMBERSHIP_PRICE_ID), key);
    const p = r.ok && r.data;
    if (!p || !p.active || !p.unit_amount || !p.recurring) throw new Error('Membership price unavailable');
    // Short CDN cache: a price change shows on the page within about a minute.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ unit_amount: p.unit_amount, currency: p.currency, interval: p.recurring.interval }));
  } catch (err) {
    console.error('membership-price error', err);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'unavailable' }));
  }
}
