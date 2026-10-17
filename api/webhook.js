// api/webhook.js
// Stripe webhook endpoint. Verifies the signature manually using Node's
// built-in crypto module (no stripe npm package required).
//
// Current duty: after a Checkout Session completes, check whether the
// customer already has another active/trialing Les Essais subscription.
// If so, this is an accidental duplicate -- cancel the newer one and
// refund its initial charge, keeping only the original subscription.
//
// Configure this URL (https://<your-domain>/api/webhook) as a webhook
// endpoint in the Stripe Dashboard, subscribed to at least
// checkout.session.completed, and put its signing secret in the
// STRIPE_WEBHOOK_SECRET environment variable.

import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const RECURRING_PRICE_ID = 'price_1UNCNVGoK2Du26V2DBc8poO5';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300) {
  if (!header) throw new Error('Missing Stripe-Signature header');
  const parts = header.split(',').reduce((acc, part) => {
    const idx = part.indexOf('=');
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'v1') { acc.v1.push(v); } else if (k === 't') { acc.t = v; }
    return acc;
  }, { v1: [], t: null });

  if (!parts.t || parts.v1.length === 0) throw new Error('Malformed Stripe-Signature header');

  const signedPayload = parts.t + '.' + payload;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const matches = parts.v1.some((sig) => {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!matches) throw new Error('Signature verification failed');

  const age = Math.floor(Date.now() / 1000) - Number(parts.t);
  if (age > toleranceSeconds) throw new Error('Timestamp outside tolerance');

  return true;
}

async function stripeGet(path, secretKey) {
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + secretKey },
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

async function stripePost(path, body, secretKey) {
  const headers = { Authorization: 'Bearer ' + secretKey };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers,
    body: body ? body.toString() : undefined,
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

async function stripeDelete(path, secretKey) {
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + secretKey },
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

async function cancelDuplicateSubscriptions(customerId, secretKey) {
  const { ok, data } = await stripeGet('subscriptions?customer=' + customerId + '&status=all&limit=20', secretKey);
  if (!ok) {
    console.error('Could not list subscriptions for', customerId, data);
    return;
  }

  const relevant = (data.data || []).filter((sub) =>
    ['active', 'trialing'].includes(sub.status) &&
    sub.items.data.some((item) => item.price && item.price.id === RECURRING_PRICE_ID)
  );

  if (relevant.length <= 1) return;

  relevant.sort((a, b) => a.created - b.created);
  const keep = relevant[0];
  const duplicates = relevant.slice(1);

  for (const dup of duplicates) {
    await stripeDelete('subscriptions/' + dup.id, secretKey);

    if (dup.latest_invoice) {
      const { ok: invOk, data: inv } = await stripeGet('invoices/' + dup.latest_invoice, secretKey);
      if (invOk) {
        const refundParams = new URLSearchParams({ reason: 'duplicate' });
        if (inv.charge) refundParams.append('charge', inv.charge);
        else if (inv.payment_intent) refundParams.append('payment_intent', inv.payment_intent);

        if (refundParams.has('charge') || refundParams.has('payment_intent')) {
          const { ok: refundOk, data: refundData } = await stripePost('refunds', refundParams, secretKey);
          if (!refundOk) console.error('Refund failed for duplicate', dup.id, refundData);
        }
      }
    }

    console.log('Cancelled & refunded duplicate subscription ' + dup.id + ' for customer ' + customerId + '; kept ' + keep.id);
  }
}

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const rawBody = await readRawBody(req);
    const payload = rawBody.toString('utf8');
    const sig = req.headers['stripe-signature'];

    verifyStripeSignature(payload, sig, STRIPE_WEBHOOK_SECRET);

    const event = JSON.parse(payload);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.customer) {
        await cancelDuplicateSubscriptions(session.customer, STRIPE_SECRET_KEY);
      }
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (err) {
    console.error('webhook.js error', err);
    res.statusCode = 400;
    res.end('Webhook Error: ' + err.message);
  }
}
