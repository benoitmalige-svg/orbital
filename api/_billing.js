// api/_billing.js
// Les Essais edition-based billing (new memberships from the V40 site onward).
//
// Rules
//   - Rate = the configured Stripe membership price (MEMBERSHIP_PRICE_ID), read
//     server-side. The subscription stays on that price, so a $49 member keeps
//     $49 for as long as the subscription remains active.
//   - Anyone who enrolls during calendar month M (business time zone) pays the
//     full monthly rate today. That payment covers the edition of month M+1.
//     The recurring price is deferred with a trial until the 1st of M+2, then
//     bills on the 1st of every month. No proration, no intro charge.
//       Nov 27 2026 -> pays today for December, next charge January 1.
//       Dec  5 2026 -> pays today for January,  next charge February 1.
//   - Outside the US, Canada and Mexico, the existing $8/month shipping item is
//     added after checkout (no proration) and is first billed on the first
//     recurring date, exactly as in the current production flow.
//   - Every paid invoice is tagged metadata[edition]=YYYY-MM so the shipping list
//     can be built from Stripe (scripts/shipping-list.mjs). Refunds flip
//     metadata[edition_status] to refunded / partially_refunded.
//
// Only subscriptions with metadata.billing_model === BILLING_MODEL are ever
// written to. Existing members (original $49 flow, intro-15 flow) are never
// touched by anything in this file.
// Files starting with "_" are not exposed as Vercel routes.

import {
  MONTH_NAMES, businessTimeZone, ymdIn, firstOfMonthUnix, isoMonth,
  stripeGet, stripePost, RetryableError, shippingCountryFor,
  DOMESTIC_COUNTRIES, INTL_SHIP_LOOKUP_KEY,
} from './_intro-billing.js';

export const BILLING_MODEL = 'edition-v1';

// The membership price is whatever Stripe price STRIPE_MEMBERSHIP_PRICE_ID points
// to (default: the existing $49/month Les Essais price). Today's payment and all
// checkout wording follow that price's amount, so changing the rate is a single
// Vercel env change to another Stripe price. Existing subscriptions keep their price.
export const MEMBERSHIP_PRICE_ID = process.env.STRIPE_MEMBERSHIP_PRICE_ID || 'price_1UNCNVGoK2Du26V2DBc8poO5';

function addMonths(year, month, n) {
  const total = (month - 1) + n;
  return { year: year + Math.floor(total / 12), month: (total % 12) + 1 };
}

export function editionIso(year, month) { return isoMonth(year, month); }

export function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})$/.exec(iso || '');
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

export function editionLabel(iso) {
  const p = parseIso(iso);
  return p ? MONTH_NAMES[p.month - 1] + ' ' + p.year : iso;
}

// Enrollment during month M -> edition M+1, first recurring charge on the 1st of M+2.
export function editionPlan(now = new Date(), timeZone = businessTimeZone()) {
  const { year, month } = ymdIn(now, timeZone);
  const edition = addMonths(year, month, 1);
  const billing = addMonths(year, month, 2);
  return {
    firstEdition: editionIso(edition.year, edition.month),
    firstRecurring: {
      year: billing.year,
      month: billing.month,
      iso: editionIso(billing.year, billing.month),
      unix: firstOfMonthUnix(billing.year, billing.month, timeZone),
      label: MONTH_NAMES[billing.month - 1] + ' 1, ' + billing.year,
    },
    // The moment this plan stops being offered (enrollment cutoff for the edition).
    cutoffUnix: firstOfMonthUnix(edition.year, edition.month, timeZone),
  };
}

// The edition a renewal invoice pays for is the month its new period starts in.
export function nextEditionAfter(iso) {
  const p = parseIso(iso);
  if (!p) return null;
  const n = addMonths(p.year, p.month, 1);
  return editionIso(n.year, n.month);
}

// Checkout Sessions must live >= 30 minutes. Expire at the enrollment cutoff when
// possible, so the quoted rate/edition cannot be used after it; at most ~31
// minutes of grace for sessions opened right before a cutoff.
export function sessionExpiry(nowSec, cutoffUnix) {
  const min = nowSec + 31 * 60;
  const max = nowSec + 60 * 60;
  return Math.max(min, Math.min(max, cutoffUnix));
}

const money = (cents) => '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

// Builds the Checkout Session body. Pure: no network.
export function buildCheckoutParams({ now = new Date(), siteUrl, recurringPriceId, rateCents, allowedCountries, intlShippingCents, timeZone = businessTimeZone() }) {
  const rate = { cents: rateCents };
  const plan = editionPlan(now, timeZone);
  const nowSec = Math.floor(now.getTime() / 1000);
  const amount = money(rate.cents);
  const edLabel = editionLabel(plan.firstEdition);
  const ship = money(intlShippingCents);
  const intlRecurring = money(rate.cents + intlShippingCents);

  const p = new URLSearchParams();
  p.append('mode', 'subscription');
  p.append('expires_at', String(sessionExpiry(nowSec, plan.cutoffUnix)));
  p.append('adaptive_pricing[enabled]', 'false'); // keep USD amounts exact

  // Today's payment: one edition, charged immediately.
  p.append('line_items[0][price_data][currency]', 'usd');
  p.append('line_items[0][price_data][product_data][name]', 'Les Essais — ' + edLabel + ' edition');
  p.append('line_items[0][price_data][product_data][description]',
    'Your first printed edition (' + edLabel + '), with immediate access to the digital library and The Symposium.');
  p.append('line_items[0][price_data][unit_amount]', String(rate.cents));
  p.append('line_items[0][quantity]', '1');

  // Recurring membership, deferred to the 1st of the month after the first edition.
  p.append('line_items[1][price]', recurringPriceId);
  p.append('line_items[1][quantity]', '1');
  p.append('subscription_data[trial_end]', String(plan.firstRecurring.unix));

  const meta = {
    product: 'les-essais',
    billing_model: BILLING_MODEL,
    membership_rate_cents: String(rate.cents),
    first_edition: plan.firstEdition,
    next_billing_date: plan.firstRecurring.iso + '-01',
    enrolled_at: new Date(nowSec * 1000).toISOString(),
  };
  for (const [k, v] of Object.entries(meta)) p.append('subscription_data[metadata][' + k + ']', v);

  // business=les-essais is what the existing fulfillment webhook keys on.
  p.append('metadata[business]', 'les-essais');
  p.append('metadata[billing_model]', BILLING_MODEL);
  p.append('metadata[first_edition]', plan.firstEdition);
  p.append('metadata[membership_rate_cents]', String(rate.cents));
  // Kept for the existing fulfillment webhook, which read this key from the previous flows.
  p.append('metadata[first_paid_issue_month]', plan.firstEdition);

  p.append('phone_number_collection[enabled]', 'true');
  p.append('billing_address_collection', 'required');
  allowedCountries.forEach((c, i) => p.append('shipping_address_collection[allowed_countries][' + i + ']', c));

  p.append('success_url', siteUrl + '/api/enroll-complete?session_id={CHECKOUT_SESSION_ID}');
  p.append('cancel_url', siteUrl + '/les-essais/?checkout=cancelled#join');

  const nextShort = MONTH_NAMES[plan.firstRecurring.month - 1] + ' 1';
  const edShort = MONTH_NAMES[parseIso(plan.firstEdition).month - 1];
  p.append('custom_text[submit][message]',
    'Today: ' + amount + ', which covers your first printed edition (' + edLabel + ') and gives you immediate access to the digital library and The Symposium. ' +
    'No charge on ' + edShort + ' 1. Your next payment is ' + amount + ' on ' + plan.firstRecurring.label +
    ', then ' + amount + ' on the 1st of each month for that month\'s edition. ' +
    'The period shown as free is simply the time until your next billing date, already covered by today\'s payment. ' +
    'Outside the US, Canada and Mexico, shipping adds ' + ship + '/month starting ' + nextShort + ' (' + intlRecurring + '/month). ' +
    'Cancel future renewals anytime.');
  p.append('custom_text[shipping_address][message]',
    'Shipping to the US, Canada and Mexico is included. Other supported destinations: ' + ship +
    '/month, starting with your ' + nextShort + ' payment (nothing extra today).');

  return { params: p, rate, plan };
}

// ---------------------------------------------------------------------------
// Webhook-side processing. Everything is idempotent: values are compared before
// writing, writes carry deterministic idempotency keys, and the event body is
// only a hint (objects are re-read with the server key).

function subscriptionIdOfInvoice(inv) {
  const direct = inv.subscription;
  if (direct) return typeof direct === 'string' ? direct : direct.id;
  const nested = inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription;
  if (nested) return typeof nested === 'string' ? nested : nested.id;
  return null;
}

async function getSub(id, secretKey, expand = '') {
  const r = await stripeGet('subscriptions/' + encodeURIComponent(id) + expand, secretKey);
  if (!r.ok && (r.status === 429 || r.status >= 500)) throw new RetryableError('subscription lookup failed (' + r.status + ')');
  return r.ok ? r.data : null;
}

function checked(r, what) {
  if (!r.ok && (r.status === 409 || r.status === 429 || r.status >= 500)) throw new RetryableError(what + ' failed (' + r.status + ')');
  if (!r.ok) console.error('billing: ' + what + ' rejected', r.status, r.data && r.data.error);
  return r.ok;
}

function metaDiff(current, desired) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(desired)) {
    if (v != null && (current || {})[k] !== String(v)) body.append('metadata[' + k + ']', String(v));
  }
  return body;
}

async function writeMeta(path, current, desired, secretKey, keyPrefix) {
  const body = metaDiff(current, desired);
  if (![...body.keys()].length) return false;
  const r = await stripePost(path, body, secretKey, keyPrefix + '-' + body.toString());
  return checked(r, 'metadata update ' + path);
}

// Other live Les Essais subscriptions for the same email (double checkout,
// two tabs, or an existing member enrolling again). Flagged, never auto-refunded.
async function findOtherActiveMemberships(sub, secretKey) {
  const cust = sub.customer && typeof sub.customer === 'object' ? sub.customer : null;
  const email = cust && cust.email;
  if (!email) return [];
  const q = encodeURIComponent("email:'" + email.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
  const c = await stripeGet('customers/search?limit=20&query=' + q, secretKey);
  if (!c.ok) return [];
  const others = [];
  for (const customer of c.data.data || []) {
    const s = await stripeGet('subscriptions?status=all&limit=20&customer=' + encodeURIComponent(customer.id), secretKey);
    if (!s.ok) continue;
    for (const o of s.data.data || []) {
      if (o.id === sub.id) continue;
      const lesEssais = o.metadata && (o.metadata.product === 'les-essais' || o.metadata.billing_model === BILLING_MODEL);
      if (lesEssais && ['active', 'trialing', 'past_due', 'unpaid'].includes(o.status)) others.push(o.id);
    }
  }
  return others;
}

// After checkout: shipping destination, international shipping item, duplicate flag.
export async function finalizeEditionSubscription(subscriptionId, secretKey) {
  const sub = await getSub(subscriptionId, secretKey, '?expand[]=customer&expand[]=items.data.price');
  if (!sub) return { status: 'not_found' };
  if (!sub.metadata || sub.metadata.billing_model !== BILLING_MODEL) return { status: 'ignored' };
  if (['canceled', 'incomplete_expired'].includes(sub.status)) return { status: 'inactive', sub: sub.id };

  const actions = [];
  const country = await shippingCountryFor(sub, secretKey);
  const intl = !!country && !DOMESTIC_COUNTRIES.includes(country);
  const desired = {};
  if (country) {
    desired.shipping_country = country;
    desired.shipping_region = intl ? 'international' : 'domestic';
  }
  const dups = await findOtherActiveMemberships(sub, secretKey);
  if (dups.length) {
    desired.possible_duplicate_of = dups.join(',');
    console.error('billing: possible duplicate membership', sub.id, 'also', dups.join(','));
  }
  if (await writeMeta('subscriptions/' + sub.id, sub.metadata, desired, secretKey, 'le-ed-sub-' + sub.id)) actions.push('metadata');

  if (intl) {
    const hasShip = sub.items.data.some((it) => it.price && it.price.lookup_key === INTL_SHIP_LOOKUP_KEY);
    if (!hasShip) {
      const p = await stripeGet('prices?active=true&lookup_keys[]=' + encodeURIComponent(INTL_SHIP_LOOKUP_KEY), secretKey);
      checked(p, 'shipping price lookup');
      const shipPrice = p.ok && p.data.data && p.data.data[0];
      if (!shipPrice) throw new RetryableError('Shipping price not found: ' + INTL_SHIP_LOOKUP_KEY);
      const body = new URLSearchParams();
      body.append('subscription', sub.id);
      body.append('price', shipPrice.id);
      body.append('quantity', '1');
      body.append('proration_behavior', 'none');
      const a = await stripePost('subscription_items', body, secretKey, 'le-ed-ship-' + sub.id);
      if (checked(a, 'shipping item add')) actions.push('shipping_added');
    }
  }
  return { status: 'ok', sub: sub.id, country, duplicates: dups, actions };
}

// Which edition an invoice pays for (null if it is not an edition payment).
export function editionForInvoice(inv, sub, timeZone = businessTimeZone()) {
  if (inv.billing_reason === 'subscription_create') return sub.metadata.first_edition || null;
  if (inv.billing_reason !== 'subscription_cycle') return null;
  const lines = (inv.lines && inv.lines.data) || [];
  const line = lines.find((l) => l.period && l.period.start && (l.amount || 0) > 0) || lines.find((l) => l.period && l.period.start);
  if (!line) return null;
  // Renewals run at 00:00 business time on the 1st; a few hours of slack avoids
  // any edge where Stripe stamps the period a moment before midnight.
  const { year, month } = ymdIn(new Date((line.period.start + 6 * 3600) * 1000), timeZone);
  return editionIso(year, month);
}

async function invoiceContext(invoiceId, secretKey) {
  const r = await stripeGet('invoices/' + encodeURIComponent(invoiceId), secretKey);
  if (!r.ok && (r.status === 429 || r.status >= 500)) throw new RetryableError('invoice lookup failed (' + r.status + ')');
  if (!r.ok) return null;
  const inv = r.data;
  const subId = subscriptionIdOfInvoice(inv);
  if (!subId) return { inv, sub: null };
  return { inv, sub: await getSub(subId, secretKey) };
}

const laterIso = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

export async function recordInvoicePaid(invoiceId, secretKey) {
  const ctx = await invoiceContext(invoiceId, secretKey);
  if (!ctx || !ctx.sub || ctx.sub.metadata.billing_model !== BILLING_MODEL) return { status: 'ignored' };
  const { inv, sub } = ctx;
  if (inv.status !== 'paid') return { status: 'not_paid', invoice: inv.id };
  const edition = editionForInvoice(inv, sub);
  if (!edition) return { status: 'no_edition', invoice: inv.id, reason: inv.billing_reason };

  const actions = [];
  const invStatus = inv.metadata && ['refunded', 'partially_refunded'].includes(inv.metadata.edition_status) ? null : 'paid';
  if (await writeMeta('invoices/' + inv.id, inv.metadata, { edition, edition_status: invStatus }, secretKey, 'le-ed-inv-' + inv.id)) actions.push('invoice_tagged');

  const lastPaid = laterIso(sub.metadata.last_paid_edition, edition);
  const next = nextEditionAfter(lastPaid);
  if (await writeMeta('subscriptions/' + sub.id, sub.metadata, {
    last_paid_edition: lastPaid,
    next_billing_date: next + '-01',
    payment_status: 'current',
  }, secretKey, 'le-ed-paid-' + sub.id)) actions.push('subscription_updated');
  return { status: 'ok', invoice: inv.id, edition, actions };
}

export async function recordInvoicePaymentFailed(invoiceId, secretKey) {
  const ctx = await invoiceContext(invoiceId, secretKey);
  if (!ctx || !ctx.sub || ctx.sub.metadata.billing_model !== BILLING_MODEL) return { status: 'ignored' };
  const { inv, sub } = ctx;
  if (inv.status === 'paid') return { status: 'already_paid', invoice: inv.id };
  const edition = editionForInvoice(inv, sub);
  const actions = [];
  if (edition && await writeMeta('invoices/' + inv.id, inv.metadata, { edition, edition_status: 'payment_failed' }, secretKey, 'le-ed-fail-' + inv.id)) actions.push('invoice_tagged');
  if (await writeMeta('subscriptions/' + sub.id, sub.metadata, { payment_status: 'failed:' + (edition || inv.id) }, secretKey, 'le-ed-failsub-' + sub.id)) actions.push('subscription_updated');
  return { status: 'ok', invoice: inv.id, edition, actions };
}

// Find the invoice a charge paid (works with both older and 2025+ API shapes).
async function invoiceIdForCharge(charge, secretKey) {
  if (charge.invoice) return typeof charge.invoice === 'string' ? charge.invoice : charge.invoice.id;
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent && charge.payment_intent.id;
  if (!pi) return null;
  const r = await stripeGet('invoice_payments?limit=1&payment[type]=payment_intent&payment[payment_intent]=' + encodeURIComponent(pi), secretKey);
  if (!r.ok && (r.status === 429 || r.status >= 500)) throw new RetryableError('invoice payment lookup failed (' + r.status + ')');
  const row = r.ok && r.data.data && r.data.data[0];
  return row ? (typeof row.invoice === 'string' ? row.invoice : row.invoice && row.invoice.id) : null;
}

export async function recordRefund(chargeId, secretKey) {
  const c = await stripeGet('charges/' + encodeURIComponent(chargeId), secretKey);
  if (!c.ok && (c.status === 429 || c.status >= 500)) throw new RetryableError('charge lookup failed (' + c.status + ')');
  if (!c.ok) return { status: 'not_found' };
  const charge = c.data;
  if (!charge.amount_refunded) return { status: 'no_refund' };
  const invoiceId = await invoiceIdForCharge(charge, secretKey);
  if (!invoiceId) return { status: 'no_invoice' };
  const ctx = await invoiceContext(invoiceId, secretKey);
  if (!ctx || !ctx.sub || ctx.sub.metadata.billing_model !== BILLING_MODEL) return { status: 'ignored' };
  const status = charge.refunded ? 'refunded' : 'partially_refunded';
  const edition = (ctx.inv.metadata && ctx.inv.metadata.edition) || editionForInvoice(ctx.inv, ctx.sub);
  const ok = await writeMeta('invoices/' + ctx.inv.id, ctx.inv.metadata, { edition, edition_status: status }, secretKey, 'le-ed-refund-' + ctx.inv.id);
  return { status: 'ok', invoice: ctx.inv.id, edition, edition_status: status, updated: ok };
}
