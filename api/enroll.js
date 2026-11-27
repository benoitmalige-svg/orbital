// api/enroll.js
// Les Essais enrollment (edition-based billing; see api/_billing.js).
//
//   - Full monthly rate today = the Stripe membership price's amount
//     (STRIPE_MEMBERSHIP_PRICE_ID, default the existing $49/month price),
//     decided here on the server, never by the page.
//   - Today's payment covers the next month's printed edition.
//   - The recurring price is deferred (trial) to the 1st of the month after that
//     edition, then bills on the 1st of every month. No proration.
//   - International shipping ($8/month outside US/CA/MX) is added by the webhook
//     after checkout and first billed on the first recurring date.
//
// The introductory $15 / $34 offer is no longer sold. Members who joined under it
// keep their subscriptions; api/enroll-webhook.js still finalizes those.
//
// Fulfillment is unchanged: session metadata business=les-essais triggers the
// existing Stripe webhook (tax project) -> Beehiiv "Les Essais - Member Welcome".

import {
  INTL_SHIPPING_CENTS, STRIPE_SHIPPING_COUNTRIES, SHIP_EXCLUDE,
  siteUrlFromRequest, stripeGet, stripePost,
} from './_intro-billing.js';
import { buildCheckoutParams, MEMBERSHIP_PRICE_ID } from './_billing.js';

export function allowedShippingCountries() {
  return process.env.SHIP_COUNTRIES
    ? process.env.SHIP_COUNTRIES.split(',').map((s) => s.trim()).filter(Boolean)
    : STRIPE_SHIPPING_COUNTRIES.filter((c) => !SHIP_EXCLUDE.includes(c));
}

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    if (process.env.ENROLLMENT_ENABLED === 'false') throw new Error('Enrollment disabled by ENROLLMENT_ENABLED=false');

    const now = new Date();
    const lookup = await stripeGet('prices/' + encodeURIComponent(MEMBERSHIP_PRICE_ID), STRIPE_SECRET_KEY);
    const price = lookup.ok && lookup.data;
    if (!price || !price.active || price.currency !== 'usd' || !price.recurring || price.recurring.interval !== 'month' || !price.unit_amount) {
      throw new Error('Membership price ' + MEMBERSHIP_PRICE_ID + ' is not an active usd monthly price; refusing to sell');
    }

    const { params } = buildCheckoutParams({
      now,
      siteUrl: SITE_URL,
      recurringPriceId: price.id,
      rateCents: price.unit_amount,
      allowedCountries: allowedShippingCountries(),
      intlShippingCents: INTL_SHIPPING_CENTS,
    });

    // No idempotency key: two people behind one IP must never share a session,
    // and Checkout Sessions are harmless until paid. Duplicate *payments* are
    // detected in the webhook (possible_duplicate_of).
    const { ok, data } = await stripePost('checkout/sessions', params, STRIPE_SECRET_KEY);
    if (!ok || !data.url) {
      console.error('Enrollment checkout session creation failed', data);
      res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error#join' });
      return res.end();
    }

    res.writeHead(303, { Location: data.url });
    res.end();
  } catch (err) {
    console.error('enroll.js error', err);
    res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error#join' });
    res.end();
  }
}
