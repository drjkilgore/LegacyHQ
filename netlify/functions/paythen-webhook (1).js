// HomegoingHQ — Paythen provisioning webhook (via Zapier).
// Zapier: Paythen "new payment/subscription" trigger → "Webhooks by Zapier → POST"
//   URL:    https://app.homegoinghq.com/.netlify/functions/paythen-webhook
//   Header: x-webhook-secret: <value of PAYTHEN_WEBHOOK_SECRET>   (or ?secret= in the URL)
//   Body:   JSON including the payer email and the plan id (or plan name).
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYTHEN_WEBHOOK_SECRET (recommended)

// Paythen plan id -> concierge tier. (Last path segment of each plan link.)
const PLAN_TIER = {
  frusqkt0ur: "starter",      fo82kbiyxi: "starter",
  kocldycond: "professional", "4tpig9m5ua": "professional",
  kf83pe9y6m: "enterprise",   dg1bg3q3in: "enterprise",
  "9qrau4sk14": "agency",     wazeflgqet: "agency"
};

// Paythen sends the plan id embedded in a long slug, e.g.
// "homegoinghq_concierge_platform_-_starter-_($49_recurring_monthly)_frusqkt0ur_plan".
// So we search the whole payload for a known plan id OR a tier word — robust to
// slug format and to whichever field the id lands in.
function tierFrom(haystack) {
  const h = (haystack || "").toLowerCase();
  for (const id in PLAN_TIER) {                    // embedded short id (most specific)
    if (h.indexOf(id.toLowerCase()) > -1) return PLAN_TIER[id];
  }
  if (h.indexOf("agency") > -1) return "agency";   // tier word anywhere (fallback)
  if (h.indexOf("enterprise") > -1) return "enterprise";
  if (h.indexOf("professional") > -1) return "professional";
  if (h.indexOf("starter") > -1) return "starter";
  return null;
}

function firstOf(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
  }
  return "";
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  // ---- shared-secret check (skip only if secret is unset, for first-run testing) ----
  const secret = process.env.PAYTHEN_WEBHOOK_SECRET;
  if (secret) {
    const given = (event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"] ||
      (event.queryStringParameters && event.queryStringParameters.secret) || "");
    if (given !== secret) return { statusCode: 401, headers, body: JSON.stringify({ error: "bad secret" }) };
  }

  // ---- parse body (JSON, or form-encoded fallback) ----
  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch { try { body = Object.fromEntries(new URLSearchParams(event.body || "")); } catch { body = {}; } }

  const email  = firstOf(body, ["email", "payer_email", "customer_email", "customerEmail", "buyer_email"]);
  const planId = firstOf(body, ["plan_id", "planId", "plan", "plan_slug", "planSlug"]);
  const planNm = firstOf(body, ["plan_name", "planName", "plan_title", "product", "product_name"]);
  const business = firstOf(body, ["business_name", "businessName", "company", "practice_name"]) || null;

  // Search the parsed fields AND the raw body, so an id embedded anywhere still matches.
  const tier = tierFrom(planId + " " + planNm + " " + (event.body || ""));
  if (!email) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, skipped: "no email" }) };
  if (!tier)  return { statusCode: 200, headers, body: JSON.stringify({ ok: false, skipped: "unrecognized plan", planId, planNm }) };

  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { statusCode: 500, headers, body: JSON.stringify({ error: "not configured" }) };

  try {
    const r = await fetch(base + "/rest/v1/rpc/provision_by_email", {
      method: "POST",
      headers: {
        "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_email: email, p_tier: tier, p_business: business,
        p_ref: planId || planNm || null, p_tenant_type: "concierge"
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: "provision failed", detail: data }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, tier, result: data }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
