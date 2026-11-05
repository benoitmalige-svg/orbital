// api/checkout.js
// Creates a Stripe Checkout Session for Les Essais:
//  - one-time $49 line item for the upcoming issue
//  - the existing $49/month recurring price
//  - renewals always land on the 1st of the month. Issues ship on the 7th
//    (CUTOFF_DAY), so the first renewal depends on the signup date:
//      * 1st-6th: the $49 pays for THIS month's issue; trial_end is the
//        1st of next month (renewal is deferred via a trial in both cases).
//      * 7th onward: this month's issue has shipped, so the $49 pays for
//        NEXT month's issue; trial_end is the 1st of the month after next.
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

// Shipping to these countries is included in the $49. Everywhere else pays an
// international shipping fee: once with the first issue, then monthly with each renewal.
const DOMESTIC_COUNTRIES = ['US', 'CA', 'MX'];
const INTL_SHIPPING_CENTS = Number(process.env.INTL_SHIPPING_CENTS || 800);

// Every country Stripe Checkout accepts for shipping_address_collection (from Stripe's API spec).
const STRIPE_SHIPPING_COUNTRIES = [
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
const SHIP_EXCLUDE = (process.env.SHIP_EXCLUDE || 'RU,AE,AQ,BV,GS,TF,ZZ')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Day of the month the issue ships. Signups before this day get this month's issue.
const CUTOFF_DAY = Number(process.env.ISSUE_CUTOFF_DAY || 7);

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
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
  const parts = fmt.formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);
  return { year, month, day };
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
  // /api/checkout?ship=intl comes from the international shipping checkbox on the page.
  const shipParam = (req.query && req.query.ship) || new URL(req.url || '/', 'http://localhost').searchParams.get('ship');
  const intl = shipParam === 'intl';
  const shipFee = '$' + (INTL_SHIPPING_CENTS / 100);

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!STRIPE_SECRET_KEY) {
      throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    }

    const { year, month, day } = getBusinessNow(TIMEZONE);
    // Before the cutoff: $49 covers this month's issue, renews on the 1st of next month.
    // On/after the cutoff: $49 covers next month's issue, renews on the 1st of the month after.
    const beforeCutoff = day < CUTOFF_DAY;
    const issue = addMonths(year, month, beforeCutoff ? 0 : 1);
    const firstRecurring = addMonths(year, month, beforeCutoff ? 1 : 2);
    const firstRenewalAt = firstOfMonthUnix(firstRecurring.year, firstRecurring.month, TIMEZONE);

    const issueLabel = monthLabel(issue.year, issue.month);
    const firstRecurringLabel = monthLabel(firstRecurring.year, firstRecurring.month);

    // Ship everywhere Stripe supports, minus SHIP_EXCLUDE. SHIP_COUNTRIES (if set) overrides with an explicit list.
    const allowedCountries = process.env.SHIP_COUNTRIES
      ? process.env.SHIP_COUNTRIES.split(',').map(s => s.trim()).filter(Boolean)
      : STRIPE_SHIPPING_COUNTRIES.filter(c => !SHIP_EXCLUDE.includes(c))
          .filter(c => intl ? !DOMESTIC_COUNTRIES.includes(c) : DOMESTIC_COUNTRIES.includes(c));

    const params = new URLSearchParams();
    params.append('mode', 'subscription');

    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', 'Les Essais — Your First Issue');
    params.append('line_items[0][price_data][product_data][description]', 'Your $49 payment covers the ' + issueLabel + ' issue.');
    params.append('line_items[0][price_data][unit_amount]', String(ONE_TIME_AMOUNT_CENTS));
    params.append('line_items[0][quantity]', '1');

    params.append('line_items[1][price]', RECURRING_PRICE_ID);
    params.append('line_items[1][quantity]', '1');

    if (intl) {
      // First issue's shipping, charged today with the one-time $49.
      params.append('line_items[2][price_data][currency]', 'usd');
      params.append('line_items[2][price_data][product_data][name]', 'International shipping — first issue');
      params.append('line_items[2][price_data][unit_amount]', String(INTL_SHIPPING_CENTS));
      params.append('line_items[2][quantity]', '1');
      // Monthly international shipping, billed with each renewal (deferred by the same trial_end).
      params.append('line_items[3][price_data][currency]', 'usd');
      params.append('line_items[3][price_data][product_data][name]', 'International shipping');
      params.append('line_items[3][price_data][unit_amount]', String(INTL_SHIPPING_CENTS));
      params.append('line_items[3][price_data][recurring][interval]', 'month');
      params.append('line_items[3][quantity]', '1');
    }

    // Charge the one-time $49 now and defer the recurring $49 to the 1st via trial_end.
    // (billing_cycle_anchor + proration_behavior=none can't be used: Stripe rejects
    // proration_behavior=none in a Checkout Session that includes a one-time price.)
    params.append('subscription_data[trial_end]', String(firstRenewalAt));
    params.append('subscription_data[metadata][first_recurring_issue_month]', isoMonth(firstRecurring.year, firstRecurring.month));
    params.append('subscription_data[metadata][product]', 'les-essais');

    params.append('metadata[first_paid_issue_month]', isoMonth(issue.year, issue.month));
    params.append('metadata[business]', 'les-essais');
    params.append('metadata[shipping_region]', intl ? 'international' : 'domestic');
    params.append('subscription_data[metadata][shipping_region]', intl ? 'international' : 'domestic');

    params.append('phone_number_collection[enabled]', 'true');
    params.append('billing_address_collection', 'required');
    allowedCountries.forEach((c, i) => params.append('shipping_address_collection[allowed_countries][' + i + ']', c));

    params.append('success_url', SITE_URL + '/les-essais/success.html?session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', SITE_URL + '/les-essais/?checkout=cancelled');

    const pay = intl ? '$49 + ' + shipFee + ' international shipping' : '$49';
    const explainer = "The period marked \"free\" means no additional payment is due before your next billing date. " +
      "Your " + pay + " today covers the " + issueLabel + " issue. Your next " + pay + " payment is " + MONTH_NAMES[firstRecurring.month - 1] + " 1, " + firstRecurring.year + ", followed by " + pay + " on the 1st of each month. Cancel anytime.";
    params.append('custom_text[submit][message]', explainer);
    params.append('custom_text[shipping_address][message]', intl
      ? 'International shipping (' + shipFee + '/month) is added for addresses outside the US, Canada and Mexico.'
      : 'Shipping to the US, Canada or Mexico is included. Shipping elsewhere? Go back and tick the international shipping box.');

    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || 'unknown';
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
    const idempotencyKey = 'les-essais-checkout-' + (intl ? 'intl-' : '') + ip + '-' + bucket;

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
