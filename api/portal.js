// api/portal.js
// Lets a customer reach the Stripe Customer Portal to manage or cancel
// their Les Essais subscription, including while it is still trialing
// (before the first automatic renewal charge).
//
// Access rules (security):
//   - ?session_id=cs_... (the Checkout Session ID Stripe appends to the
//     success URL): accepted only for a completed Les Essais session created
//     within SESSION_LINK_MAX_AGE_DAYS. The ID is a long random value known
//     only to the customer who paid.
//   - ?customer=cus_... is NO LONGER accepted (anyone who learned a customer ID
//     could open that customer's portal).
//   - Anything else (no/expired/invalid session) goes to Stripe's portal login
//     page, where the member verifies their email with a one-time code. This
//     keeps access for every existing and new subscriber.

const PORTAL_LOGIN_URL = process.env.STRIPE_PORTAL_LOGIN_URL || 'https://billing.stripe.com/p/login/00w5kDfzocf8gbu62A5Rm00';
const SESSION_LINK_MAX_AGE_DAYS = Number(process.env.PORTAL_SESSION_LINK_MAX_AGE_DAYS || 30);

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
    const sessionId = url.searchParams.get('session_id') || '';

    let customerId = null;
    if (/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
      const { ok, data } = await stripeGet('checkout/sessions/' + encodeURIComponent(sessionId), STRIPE_SECRET_KEY);
      const fresh = ok && data.created && (Date.now() / 1000 - data.created) < SESSION_LINK_MAX_AGE_DAYS * 86400;
      const isLesEssais = ok && data.metadata && data.metadata.business === 'les-essais';
      if (ok && data.status === 'complete' && isLesEssais && fresh && data.customer) {
        customerId = typeof data.customer === 'string' ? data.customer : data.customer.id;
      }
    }

    if (!customerId) {
      // No valid session link: verified sign-in via Stripe's portal login page.
      res.writeHead(302, { Location: PORTAL_LOGIN_URL });
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
    res.writeHead(302, { Location: PORTAL_LOGIN_URL });
    res.end();
  }
}
