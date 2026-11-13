// api/checkout.js
// RETIRED. This was the original $49 Les Essais checkout. New members now
// enroll through /api/enroll ($15 today, $34 / $49 on the 1st). Nothing on the
// site links here any more; any old bookmark or link is sent to the current
// offer instead of creating a checkout session.
//
// Existing subscribers are unaffected: their subscriptions live in Stripe and
// are managed through /api/portal, which does not depend on this file.

function siteUrlFromRequest(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return 'https://me.benoitmalige.com';
  return proto + '://' + host;
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: siteUrlFromRequest(req) + '/les-essais/#join' });
  res.end();
}
