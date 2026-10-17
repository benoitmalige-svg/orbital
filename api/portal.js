// api/portal.js
// Lets a customer reach the Stripe Customer Portal to manage or cancel
// their Les Essais subscription, including while it is still trialing
// (before the first automatic renewal charge).
//
// Expects a ?session_id=cs_... query param (the Checkout Session ID that
// Stripe appends to success_url). Looks up that session to find the
// customer, then creates a Billing Portal session and redirects there.

function siteUrlFromRequest(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return 'https://me.benoitmalige.com';
  return proto + '://' + host;
}

async function stripeGet(path, secretKey) {
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + secretKey },
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

async function stripePost(path, body, secretKey) {
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

export default async function handler(req, res) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = siteUrlFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');

    const url = new URL(req.url, 'https://placeholder.local');
    const sessionId = url.searchParams.get('session_id');
    const customerIdParam = url.searchParams.get('customer');

    let customerId = customerIdParam;

    if (!customerId && sessionId) {
      const { ok, data } = await stripeGet('checkout/sessions/' + encodeURIComponent(sessionId), STRIPE_SECRET_KEY);
      if (ok && data.customer) customerId = data.customer;
    }

    if (!customerId) {
      res.writeHead(302, { Location: SITE_URL + '/les-essais/' });
      return res.end();
    }

    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', SITE_URL + '/les-essais/');

    const { ok, data } = await stripePost('billing_portal/sessions', params, STRIPE_SECRET_KEY);

    if (!ok || !data.url) {
      console.error('Portal session creation failed', data);
      res.writeHead(302, { Location: SITE_URL + '/les-essais/' });
      return res.end();
    }

    res.writeHead(303, { Location: data.url });
    res.end();
  } catch (err) {
    console.error('portal.js error', err);
    res.writeHead(302, { Location: SITE_URL + '/les-essais/' });
    res.end();
  }
}
