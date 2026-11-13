// api/enroll-webhook.js
// Stripe webhook for the Les Essais intro enrollment flow.
// Events: checkout.session.completed, customer.subscription.created
//
// Security:
//   1. Every request must carry a valid Stripe-Signature for the endpoint's
//      signing secret (STRIPE_ENROLL_WEBHOOK_SECRET; comma-separate to allow a
//      rotation overlap). Fails closed: if the secret is not configured the
//      handler returns 500 and Stripe keeps retrying until it is.
//   2. The event body is then used only as a hint: the subscription is re-read
//      from Stripe with the server's own key, and only idempotent changes are
//      applied (finalizeIntroSubscription). Duplicate and late deliveries are
//      no-ops. Transient Stripe errors return 500 so Stripe retries (3 days).
//
// Welcome email / Beehiiv fulfillment stays in the existing tax-project webhook.

import crypto from 'crypto';
import { finalizeIntroSubscription } from './_intro-billing.js';

export const config = { api: { bodyParser: false } }; // raw body for signature check

const HANDLED = new Set(['checkout.session.completed', 'customer.subscription.created']);
const TOLERANCE_SECONDS = 300;

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export function verifyStripeSignature(rawBody, header, secrets, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secrets.length) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - t) > TOLERANCE_SECONDS) return false;
  const payload = t + '.' + rawBody.toString('utf8');
  return secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    return sigs.some((s) => s.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(s, 'utf8'), Buffer.from(expected, 'utf8')));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const secrets = (process.env.STRIPE_ENROLL_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!secrets.length) {
    console.error('enroll-webhook: STRIPE_ENROLL_WEBHOOK_SECRET is not configured; rejecting (Stripe will retry)');
    return res.status(500).json({ error: 'not_configured' });
  }

  const raw = await readRaw(req);
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secrets)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  if (!HANDLED.has(type) || !obj) return res.status(200).json({ received: true, ignored: true });

  // Ignore events from the other mode (e.g. a test event hitting production).
  const keyIsLive = (STRIPE_SECRET_KEY || '').startsWith('sk_live_') || (STRIPE_SECRET_KEY || '').startsWith('rk_live_');
  if (typeof event.livemode === 'boolean' && event.livemode !== keyIsLive) {
    return res.status(200).json({ received: true, ignored: 'mode_mismatch' });
  }

  const subscriptionId = type === 'customer.subscription.created'
    ? obj.id
    : (typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id);
  if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    return res.status(200).json({ received: true, ignored: 'no_subscription' });
  }

  try {
    const result = await finalizeIntroSubscription(subscriptionId, STRIPE_SECRET_KEY);
    if (result.status === 'ok') console.log('enroll-webhook', type, JSON.stringify(result));
    return res.status(200).json({ received: true, result });
  } catch (err) {
    console.error('enroll-webhook error', type, subscriptionId, err);
    return res.status(500).json({ error: 'retry' });
  }
}
