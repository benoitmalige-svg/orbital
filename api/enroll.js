// api/enroll.js
// NEW Les Essais enrollment flow (V18 site). Separate from api/checkout.js,
// which is left untouched for the existing $49 flow.
//
// Billing:
//   - $15 today (one-time line item, charged at Checkout; creates the subscription)
//   - $34 on the next calendar 1st  ($49 intro price minus the $15 coupon)
//   - $49 on every 1st after that
// The subscription trials until the next 1st, so cancelling before then
// (Customer Portal, cancel at period end) means no further charges.
//
// Outside the U.S., Canada and Mexico: same $15 today; $8/month shipping is added
// server-side after checkout and first billed on the next 1st ($42, then $57).
//
// Stripe Checkout requires a trial to end at least 48 hours out. For signups
// in the last ~2 days of a month the trial is set just past 48 hours and the
// webhook (api/enroll-webhook.js, with retries) pulls it back to the 1st.
//
// Fulfillment is unchanged: session metadata business=les-essais triggers the
// existing Stripe webhook (tax project) -> Beehiiv "Les Essais - Member Welcome".

import {
  INTRO_OFFER, INTRO_AMOUNT_CENTS, INTRO_PRICE_LOOKUP_KEY, INTRO_COUPON_ID, MONTH_NAMES,
  INTL_SHIPPING_CENTS, STRIPE_SHIPPING_COUNTRIES, SHIP_EXCLUDE,
  businessTimeZone, siteUrlFromRequest, nextFirst, monthLabel, isoMonth, stripeGet, stripePost,
} from './_intro-billing.js';

const MIN_TRIAL_SECONDS = 48 * 3600 + 15 * 60; // Stripe minimum + margin
const SESSION_TTL_SECONDS = 60 * 60;           // keep the quoted dates valid

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  const TIMEZONE = businessTimeZone();
  const shipFee = '$' + (INTL_SHIPPING_CENTS / 100);

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');

    const priceLookup = await stripeGet(
      'prices?active=true&lookup_keys[]=' + encodeURIComponent(INTRO_PRICE_LOOKUP_KEY), STRIPE_SECRET_KEY);
    const introPrice = priceLookup.ok && priceLookup.data.data && priceLookup.data.data[0];
    if (!introPrice) throw new Error('Intro price not found for lookup_key ' + INTRO_PRICE_LOOKUP_KEY);

    const nowSec = Math.floor(Date.now() / 1000);
    const first = nextFirst(new Date(), TIMEZONE);
    const trialEnd = Math.max(first.unix, nowSec + MIN_TRIAL_SECONDS);
    const firstLabel = MONTH_NAMES[first.month - 1] + ' 1, ' + first.year;

    const allowedCountries = process.env.SHIP_COUNTRIES
      ? process.env.SHIP_COUNTRIES.split(',').map((s) => s.trim()).filter(Boolean)
      : STRIPE_SHIPPING_COUNTRIES.filter((c) => !SHIP_EXCLUDE.includes(c))
          ;

    const p = new URLSearchParams();
    p.append('mode', 'subscription');
    p.append('expires_at', String(nowSec + SESSION_TTL_SECONDS));
    // Keep the offer in USD so $15 / $34 / $49 stay exact.
    p.append('adaptive_pricing[enabled]', 'false');

    p.append('line_items[0][price_data][currency]', 'usd');
    p.append('line_items[0][price_data][product_data][name]', 'Les Essais — Introductory Membership');
    p.append('line_items[0][price_data][product_data][description]', '$15 today, credited toward your first $49 month.');
    p.append('line_items[0][price_data][unit_amount]', String(INTRO_AMOUNT_CENTS));
    p.append('line_items[0][quantity]', '1');

    p.append('line_items[1][price]', introPrice.id);
    p.append('line_items[1][quantity]', '1');

    // $15 off the membership for one month from today = the next 1st only ($34).
    p.append('discounts[0][coupon]', INTRO_COUPON_ID);

    p.append('subscription_data[trial_end]', String(trialEnd));
    p.append('subscription_data[metadata][product]', 'les-essais');
    p.append('subscription_data[metadata][offer]', INTRO_OFFER);
    p.append('subscription_data[metadata][first_recurring_issue_month]', isoMonth(first.year, first.month));

    // business=les-essais is what the existing fulfillment webhook keys on.
    p.append('metadata[business]', 'les-essais');
    p.append('metadata[offer]', INTRO_OFFER);
    p.append('metadata[first_paid_issue_month]', isoMonth(first.year, first.month));

    p.append('phone_number_collection[enabled]', 'true');
    p.append('billing_address_collection', 'required');
    allowedCountries.forEach((c, i) => p.append('shipping_address_collection[allowed_countries][' + i + ']', c));

    p.append('success_url', SITE_URL + '/api/enroll-complete?session_id={CHECKOUT_SESSION_ID}');
    p.append('cancel_url', SITE_URL + '/les-essais/?checkout=cancelled#join');

    const first34 = 49 - INTRO_AMOUNT_CENTS / 100;
    const firstShort = MONTH_NAMES[first.month - 1] + ' 1';
    p.append('custom_text[submit][message]',
      '$15 today, credited toward your first full month. ' +
      'Your membership renews automatically at $' + first34 + ' on ' + firstShort + ', then $49 on the 1st of each following month. ' +
      'International shipping, where applicable, adds ' + shipFee + '/month starting with your first renewal. ' +
      'Cancel anytime before your next charge using the subscription management link in your welcome email.');
    p.append('custom_text[shipping_address][message]',
      'Shipping to the U.S., Canada and Mexico is included. Elsewhere: ' + shipFee + '/month shipping, beginning with your first renewal on ' + firstLabel + ' (nothing extra today).');

    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
    const idempotencyKey = 'les-essais-enroll-' + ip + '-' + bucket;

    const { ok, data } = await stripePost('checkout/sessions', p, STRIPE_SECRET_KEY, idempotencyKey);
    if (!ok || !data.url) {
      console.error('Enrollment checkout session creation failed', data);
      res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error' });
      return res.end();
    }

    res.writeHead(303, { Location: data.url });
    res.end();
  } catch (err) {
    console.error('enroll.js error', err);
    res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error' });
    res.end();
  }
}
