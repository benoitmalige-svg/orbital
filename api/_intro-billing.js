// api/_intro-billing.js
// Shared helpers for the Les Essais introductory enrollment flow
// ($15 today, $34 on the next calendar 1st, then $49 on every 1st).
// Files starting with "_" are not exposed as Vercel routes.

export const INTRO_OFFER = 'intro-15';
export const INTRO_AMOUNT_CENTS = 1500;
// Separate $49/month price for this flow (looked up by lookup_key so the same
// code works in test and live mode). The existing $49 price is never touched.
export const INTRO_PRICE_LOOKUP_KEY = process.env.STRIPE_INTRO_PRICE_LOOKUP_KEY || 'les_essais_intro_49_monthly';
// $15 off, duration=repeating for 1 month, applies only to the membership product.
// It starts at enrollment, so it always covers the next 1st and never the one after.
export const INTRO_COUPON_ID = process.env.STRIPE_INTRO_COUPON_ID || 'les-essais-intro-15';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function businessTimeZone() {
  return process.env.BUSINESS_TIMEZONE || 'America/New_York';
}

export function siteUrlFromRequest(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return 'https://me.benoitmalige.com';
  return proto + '://' + host;
}

function ymdIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second));
  return asUTC - date.getTime();
}

function firstOfMonthUnix(year, month, timeZone) {
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // Two passes so the offset is the one in effect at local midnight (DST-safe).
  let ts = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  ts = guess - timeZoneOffsetMs(new Date(ts), timeZone);
  return Math.floor(ts / 1000);
}

// The next calendar 1st (00:00 business time) strictly after `now`.
export function nextFirst(now = new Date(), timeZone = businessTimeZone()) {
  const { year, month } = ymdIn(now, timeZone);
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return { year: y, month: m, unix: firstOfMonthUnix(y, m, timeZone) };
}

export function monthLabel(year, month) {
  return MONTH_NAMES[month - 1] + ' ' + year;
}

export function isoMonth(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

async function stripeFetch(method, path, { body, secretKey, idempotencyKey } = {}) {
  const headers = { Authorization: 'Bearer ' + secretKey };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method, headers, body: body ? body.toString() : undefined,
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

export const stripeGet = (path, secretKey) => stripeFetch('GET', path, { secretKey });
export const stripePost = (path, body, secretKey, idempotencyKey) =>
  stripeFetch('POST', path, { body, secretKey, idempotencyKey });

// $8/month international shipping, added to the subscription after checkout
// (never charged at signup; first billed with the first renewal).
export const INTL_SHIP_LOOKUP_KEY = process.env.STRIPE_INTL_SHIP_LOOKUP_KEY || 'les_essais_intl_shipping_monthly';

class RetryableError extends Error {}

function failIfRetryable(r, what) {
  // 409 (concurrent idempotent request) / 429 / 5xx / network: throw so the webhook returns 500 and Stripe retries.
  if (!r.ok && (r.status === 409 || r.status === 429 || r.status >= 500)) throw new RetryableError(what + ' failed (' + r.status + ')');
}

async function shippingCountryFor(sub, secretKey) {
  const s = await stripeGet('checkout/sessions?limit=1&subscription=' + encodeURIComponent(sub.id), secretKey);
  failIfRetryable(s, 'session lookup');
  const session = s.ok && s.data.data && s.data.data[0];
  const fromSession = session && (
    (session.collected_information && session.collected_information.shipping_details &&
      session.collected_information.shipping_details.address) ||
    (session.shipping_details && session.shipping_details.address));
  if (fromSession && fromSession.country) return fromSession.country;
  const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : null;
  return (cust && cust.shipping && cust.shipping.address && cust.shipping.address.country) || null;
}

// Idempotent server-side finalization of an intro-offer subscription.
// Safe to run any number of times, concurrently, from the webhook and the
// success page. Never touches subscriptions without metadata.offer=intro-15.
//   1. First renewal ($34 / $42) on the next calendar 1st after the subscription
//      was created (Checkout can only set a trial >= 48h out).
//   2. International address -> add the $8/month shipping item (no proration).
export async function finalizeIntroSubscription(subscriptionId, secretKey) {
  const r = await stripeGet('subscriptions/' + encodeURIComponent(subscriptionId) +
    '?expand[]=customer&expand[]=items.data.price', secretKey);
  failIfRetryable(r, 'subscription lookup');
  if (!r.ok) return { status: 'not_found' };
  const sub = r.data;
  if (!sub.metadata || sub.metadata.offer !== INTRO_OFFER) return { status: 'ignored' };
  if (sub.status !== 'trialing') return { status: 'not_trialing', sub: sub.id };

  const actions = [];
  const target = nextFirst(new Date(sub.start_date * 1000), businessTimeZone()).unix;

  const country = await shippingCountryFor(sub, secretKey);
  const intl = !!country && !DOMESTIC_COUNTRIES.includes(country);
  const region = country ? (intl ? 'international' : 'domestic') : null;

  const update = new URLSearchParams();
  if (sub.trial_end !== target) {
    update.append('trial_end', String(target));
    update.append('proration_behavior', 'none');
  }
  if (region && sub.metadata.shipping_region !== region) update.append('metadata[shipping_region]', region);
  if (country && sub.metadata.shipping_country !== country) update.append('metadata[shipping_country]', country);
  if ([...update.keys()].length) {
    const u = await stripePost('subscriptions/' + sub.id, update, secretKey,
      'le-intro-sub-' + sub.id + '-' + update.toString());
    failIfRetryable(u, 'subscription update');
    if (!u.ok) {
      console.error('finalize: subscription update rejected', sub.id, u.data && u.data.error);
      actions.push('update_rejected');
    } else actions.push('updated:' + [...new Set(update.keys())].join(','));
  }

  if (intl) {
    const hasShip = sub.items.data.some((it) => it.price && it.price.lookup_key === INTL_SHIP_LOOKUP_KEY);
    if (!hasShip) {
      const p = await stripeGet('prices?active=true&lookup_keys[]=' + encodeURIComponent(INTL_SHIP_LOOKUP_KEY), secretKey);
      failIfRetryable(p, 'shipping price lookup');
      const shipPrice = p.ok && p.data.data && p.data.data[0];
      if (!shipPrice) throw new RetryableError('Shipping price not found: ' + INTL_SHIP_LOOKUP_KEY);
      const body = new URLSearchParams();
      body.append('subscription', sub.id);
      body.append('price', shipPrice.id);
      body.append('quantity', '1');
      body.append('proration_behavior', 'none');
      const a = await stripePost('subscription_items', body, secretKey, 'le-intro-ship-' + sub.id);
      failIfRetryable(a, 'shipping item add');
      if (!a.ok) {
        console.error('finalize: shipping item rejected', sub.id, a.data && a.data.error);
        actions.push('shipping_rejected');
      } else actions.push('shipping_added');
    }
  }
  return { status: 'ok', sub: sub.id, country, target, actions };
}

export { RetryableError };

// NEW intro flow only (approved policy, V24): shipping is included in the US
// only. Every other supported country, including Canada and Mexico, pays
// $8/month from the first renewal. The existing flow (api/checkout.js) and
// existing subscriptions keep their own US/CA/MX rule and are not affected.
export const DOMESTIC_COUNTRIES = ['US'];
export const INTL_SHIPPING_CENTS = Number(process.env.INTL_SHIPPING_CENTS || 800);

// Every country Stripe Checkout accepts for shipping_address_collection (from Stripe's API spec).
export const STRIPE_SHIPPING_COUNTRIES = [
  'AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE',
  'BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF',
  'CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC',
  'EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL',
  'GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN',
  'IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB',
  'LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO',
  'MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU',
  'NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU',
  'RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX',
  'SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG',
  'US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ',
];

// Countries we can't mail to, plus uninhabited territories and Stripe's 'ZZ' (unknown).
export const SHIP_EXCLUDE = (process.env.SHIP_EXCLUDE || 'RU,AE,AQ,BV,GS,TF,ZZ')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

