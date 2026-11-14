// api/purpose-subscribe.js
// Signup endpoint for the free Purpose essay (me.benoitmalige.com/purpose).
//
// 1. Validates the email (and that the request comes from this site).
// 2. Creates the subscriber in Beehiiv (The Second Life) with source
//    attribution utm_source=identity-tax-purpose, or finds the existing one.
// 3. Tags the subscriber "identity-tax-purpose" (new and existing).
// 4. Enrolls them in the separate "Purpose – Essay Delivery" automation,
//    which emails the PDF. That automation allows re-entry once per 24h
//    (max 3), so double clicks and repeat requests don't send duplicates.
//
// The Beehiiv API key lives only in the server environment (BEEHIIV_API_KEY).
// This flow is independent from Stripe and the paid Les Essais welcome.

const PUBLICATION_ID = process.env.BEEHIIV_PUBLICATION_ID || 'pub_5fe64175-3ad7-4fc5-ae48-ef7d6b6631c2';
const AUTOMATION_ID = process.env.BEEHIIV_PURPOSE_AUTOMATION_ID || 'aut_b0510b02-12ed-47d2-9b48-c4849a5018c0';
const SOURCE = 'identity-tax-purpose';
const API = 'https://api.beehiiv.com/v2/publications/' + PUBLICATION_ID;

// Best-effort rate limiting (per server instance).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_PER_EMAIL = 3;
const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

function sameSite(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  try { return !!origin && new URL(origin).host === host; } catch (e) { return false; }
}

async function beehiiv(method, path, body, key) {
  const resp = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* empty body */ }
  return { ok: resp.ok, status: resp.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!sameSite(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

  const key = process.env.BEEHIIV_API_KEY;
  if (!key) {
    console.error('purpose-subscribe: BEEHIIV_API_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited('ip:' + ip, MAX_PER_IP) || limited('em:' + email, MAX_PER_EMAIL)) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }

  try {
    // Create, or return the existing subscriber. Source attribution only
    // applies to new subscribers; existing ones keep their original source.
    const sub = await beehiiv('POST', '/subscriptions', {
      email,
      reactivate_existing: true,
      send_welcome_email: false,
      utm_source: SOURCE,
      utm_medium: 'landing_page',
      utm_campaign: 'purpose',
      referring_site: 'https://me.benoitmalige.com/purpose',
    }, key);
    if (!sub.ok || !sub.data || !sub.data.data || !sub.data.data.id) {
      console.error('purpose-subscribe: create failed', sub.status, sub.data);
      return res.status(502).json({ ok: false, error: 'subscribe_failed' });
    }
    const subscriptionId = sub.data.data.id;

    const tag = await beehiiv('POST', '/subscriptions/' + subscriptionId + '/tags', { tags: [SOURCE] }, key);
    if (!tag.ok) console.error('purpose-subscribe: tag failed', tag.status, tag.data);

    // Deliver the essay (new and existing subscribers).
    const journey = await beehiiv('POST', '/automations/' + AUTOMATION_ID + '/journeys',
      { subscription_id: subscriptionId }, key);
    if (!journey.ok) {
      // 4xx here usually means the 24h re-entry limit: the essay was just sent.
      if (journey.status >= 500 || journey.status === 401 || journey.status === 404) {
        console.error('purpose-subscribe: enroll failed', journey.status, journey.data);
        return res.status(502).json({ ok: false, error: 'delivery_failed' });
      }
      console.log('purpose-subscribe: enroll skipped', journey.status, journey.data);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('purpose-subscribe error', err);
    return res.status(502).json({ ok: false, error: 'upstream_error' });
  }
}
