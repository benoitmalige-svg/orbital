// api/checkout.js
// Creates a Stripe Checkout Session for Les Essais:
//  - one-time $49 line item for the upcoming issue
//  - the existing $49/month recurring price
//  - subscription_data.trial_end set to the 1st of the month two calendar
//    months after signup, so the first automatic renewal lands on the 1st
//
// Uses Stripe's plain REST API via fetch (no npm dependency required).
// STRIPE_SECRET_KEY must be set as a Vercel environment variable and is
// never present in any browser-side code.
//
// STRIPE_PRODUCT_ID / STRIPE_RECURRING_PRICE_ID can be overridden via env
// vars (used for test-mode IDs on preview deployments). They default to
// the live Les Essais product and price.

const PRODUCT_ID = process.env.STRIPE_PRODUCT_ID || 'prod_VNyKVsDGHS6a0b';
const RECURRING_PRICE_ID = process.env.STRIPE_RECURRING_PRICE_ID || 'price_1UNCNVGoK2Du26V2DBc8poO5';
const ONE_TIME_AMOUNT_CENTS = 4900;

const MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

function siteUrlFromRequest(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return 'https://me.benoitmalige.com';
  return proto + '://' + host;
}

function getBusinessNow(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' });
  const parts = fmt.formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  return { year, month };
}

function addMonths(year, month, n) {
  const total = (month - 1) + n;
  const newYear = year + Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return { year: newYear, month: newMonth };
}

function timeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
  return asUTC - date.getTime();
}

function firstOfMonthUnix(year, month, timeZone) {
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  return Math.floor((guess - offset) / 1000);
}

function monthLabel(year, month) {
  return MONTH_NAMES[month - 1] + ' ' + year;
}

function isoMonth(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

async function stripeRequest(path, { body, secretKey, idempotencyKey } = {}) {
  const headers = { Authorization: 'Bearer ' + secretKey };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers,
    body: body ? body.toString() : undefined,
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  const TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/New_York';

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!STRIPE_SECRET_KEY) {
      throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    }

    const { year, month } = getBusinessNow(TIMEZONE);
    const issue = addMonths(year, month, 1);
    const firstRecurring = addMonths(year, month, 2);
    const trialEnd = firstOfMonthUnix(firstRecurring.year, firstRecurring.month, TIMEZONE);

    const issueLabel = monthLabel(issue.year, issue.month);
    const firstRecurringLabel = monthLabel(firstRecurring.year, firstRecurring.month);

    const allowedCountries = (process.env.SHIP_COUNTRIES || 'US,CA,GB,FR,DE,AU,BE,CH,NL,ES,IT')
      .split(',').map(s => s.trim()).filter(Boolean);

    const params = new URLSearchParams();
    params.append('mode', 'subscription');

    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', 'Les Essais — Your First Issue');
    params.append('line_items[0][price_data][product_data][description]', "Your $49 payment covers next month's issue, paid in advance.");
    params.append('line_items[0][price_data][unit_amount]', String(ONE_TIME_AMOUNT_CENTS));
    params.append('line_items[0][quantity]', '1');

    params.append('line_items[1][price]', RECURRING_PRICE_ID);
    params.append('line_items[1][quantity]', '1');

    params.append('subscription_data[trial_end]', String(trialEnd));
    params.append('subscription_data[metadata][first_recurring_issue_month]', isoMonth(firstRecurring.year, firstRecurring.month));
    params.append('subscription_data[metadata][product]', 'les-essais');

    params.append('metadata[first_paid_issue_month]', isoMonth(issue.year, issue.month));
    params.append('metadata[business]', 'les-essais');

    params.append('phone_number_collection[enabled]', 'true');
    params.append('billing_address_collection', 'required');
    allowedCountries.forEach((c, i) => params.append('shipping_address_collection[allowed_countries][' + i + ']', c));

    params.append('success_url', SITE_URL + '/les-essais/success.html?session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', SITE_URL + '/les-essais/?checkout=cancelled');

    const explainer = "The period marked \"free\" means no additional payment is due before your next billing date. " +
      "Your next $49 payment is " + MONTH_NAMES[firstRecurring.month - 1] + " 1, " + firstRecurring.year + ", followed by $49 on the 1st of each month. Cancel anytime.";
    params.append('custom_text[submit][message]', explainer);

    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || 'unknown';
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
    const idempotencyKey = 'les-essais-checkout-' + ip + '-' + bucket;

    const { ok, data } = await stripeRequest('checkout/sessions', {
      body: params,
      secretKey: STRIPE_SECRET_KEY,
      idempotencyKey,
    });

    if (!ok || !data.url) {
      console.error('Checkout session creation failed', data);
      res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error' });
      return res.end();
    }

    res.writeHead(303, { Location: data.url });
    res.end();
  } catch (err) {
    console.error('checkout.js error', err);
    res.writeHead(302, { Location: SITE_URL + '/les-essais/?checkout=error' });
    res.end();
  }
}
