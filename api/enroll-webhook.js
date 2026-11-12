// api/enroll-webhook.js
// Stripe webhook for the Les Essais intro enrollment flow.
// Events: checkout.session.completed, customer.subscription.created
//
// The event body is treated only as a hint: the handler re-reads the
// subscription from Stripe with the server's own key and applies idempotent
// changes (finalizeIntroSubscription). A forged or replayed event can therefore
// do nothing except re-run the same safe normalization, so no signing secret
// is required. Duplicate and late deliveries are no-ops. Transient Stripe
// errors return 500 so Stripe retries (up to 3 days).
//
// Welcome email / Beehiiv fulfillment stays in the existing tax-project webhook.

import { finalizeIntroSubscription } from './_intro-billing.js';

const HANDLED = new Set(['checkout.session.completed', 'customer.subscription.created']);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  let event;
  try { event = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
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
