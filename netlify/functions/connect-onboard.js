// HomegoingHQ — Stripe Connect Express onboarding for designers.
// The signed-in designer creates/links an Express account (Stripe-hosted KYC +
// bank) and we sync payout-enabled status. Raw Stripe REST to match the repo.
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SITE_URL
const H = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: H, body: JSON.stringify({ error: "POST only" }) };

  const SK = process.env.STRIPE_SECRET_KEY;
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || KEY;
  if (!SK || !SB || !KEY) return { statusCode: 500, headers: H, body: JSON.stringify({ error: "server not configured" }) };

  const svc = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
  const form = (obj) => { const p = new URLSearchParams(); for (const k in obj) p.append(k, obj[k]); return p.toString(); };
  const stripePost = async (path, body, idem) => {
    const h = { Authorization: "Bearer " + SK, "Content-Type": "application/x-www-form-urlencoded" };
    if (idem) h["Idempotency-Key"] = idem;
    const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers: h, body });
    return { ok: r.ok, data: await r.json() };
  };
  const stripeGet = async (path) => {
    const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: "Bearer " + SK } });
    return { ok: r.ok, data: await r.json() };
  };

  try {
    const { token, action } = JSON.parse(event.body || "{}");
    // ---- diagnostic: which Stripe account is this key, and is Connect on? ----
    if (action === "whoami") {
      const who = await fetch("https://api.stripe.com/v1/account", { headers: { Authorization: "Bearer " + SK } });
      const wd = await who.json();
      return { statusCode: 200, headers: H, body: JSON.stringify({
        key_last4: SK.slice(-4),
        livemode: SK.indexOf("sk_live_") === 0,
        account_id: wd.id || null,
        business_name: (wd.settings && wd.settings.dashboard && wd.settings.dashboard.display_name) || wd.business_profile && wd.business_profile.name || null,
        charges_enabled: wd.charges_enabled,
        payouts_enabled: wd.payouts_enabled,
        connect_capable: !!(wd.capabilities || wd.controller || wd.type),
        stripe_error: wd.error ? wd.error.message : null
      }) };
    }
    if (!token) return { statusCode: 401, headers: H, body: JSON.stringify({ error: "not signed in" }) };

    // Identify the caller from their Supabase JWT.
    const uResp = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + token } });
    if (!uResp.ok) return { statusCode: 401, headers: H, body: JSON.stringify({ error: "invalid session" }) };
    const user = await uResp.json();
    const uid = user && user.id;
    if (!uid) return { statusCode: 401, headers: H, body: JSON.stringify({ error: "invalid session" }) };

    // Load their designer row (service role).
    const dResp = await fetch(SB + "/rest/v1/designers?user_id=eq." + encodeURIComponent(uid) +
      "&select=id,email,full_name,stripe_account_id,status&limit=1", { headers: svc });
    const dRows = await dResp.json();
    const designer = Array.isArray(dRows) ? dRows[0] : null;
    if (!designer) return { statusCode: 404, headers: H, body: JSON.stringify({ error: "no designer profile" }) };

    let acct = designer.stripe_account_id || null;

    // ---- refresh: sync payouts_enabled from Stripe ----
    if (action === "refresh") {
      if (!acct) return { statusCode: 200, headers: H, body: JSON.stringify({ connected: false, payouts_enabled: false }) };
      const a = await stripeGet("accounts/" + encodeURIComponent(acct));
      if (!a.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: (a.data.error && a.data.error.message) || "stripe error" }) };
      const enabled = !!a.data.payouts_enabled;
      const patch = { payouts_enabled: enabled };
      if (enabled) patch.connect_onboarded_at = new Date().toISOString();
      await fetch(SB + "/rest/v1/designers?id=eq." + encodeURIComponent(designer.id),
        { method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return { statusCode: 200, headers: H, body: JSON.stringify({ connected: true, payouts_enabled: enabled }) };
    }

    // ---- start (default): ensure an Express account, then an onboarding link ----
    if (!acct) {
      // Modern Connect: use controller properties instead of the legacy
      // type:"express". Same result — Stripe-hosted onboarding, Express-style
      // dashboard, platform pays fees + owns losses — but this is the account
      // shape Stripe now enables by default, avoiding the legacy "sign up for
      // Connect" rejection on newer platforms.
      const created = await stripePost("accounts", form({
        "country": "US",
        "email": designer.email || "",
        "controller[stripe_dashboard][type]": "express",
        "controller[fees][payer]": "application",
        "controller[losses][payments]": "application",
        "controller[requirement_collection]": "stripe",
        "capabilities[transfers][requested]": "true",
        "business_type": "individual",
        "business_profile[product_description]": "Memorial and funeral design services via HomegoingHQ",
        "metadata[designer_id]": designer.id,
        "metadata[platform]": "homegoinghq",
      }), "acct-" + designer.id + "-" + Math.floor(Date.now()/60000));
      if (!created.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: (created.data.error && created.data.error.message) || "could not create account" }) };
      acct = created.data.id;
      await fetch(SB + "/rest/v1/designers?id=eq." + encodeURIComponent(designer.id),
        { method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify({ stripe_account_id: acct }) });
    }

    const base = process.env.SITE_URL || ("https://" + (event.headers.host || ""));
    const link = await stripePost("account_links", form({
      "account": acct,
      "refresh_url": base + "/?designer=connect_refresh",
      "return_url": base + "/?designer=connect_return",
      "type": "account_onboarding",
    }));
    if (!link.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: (link.data.error && link.data.error.message) || "could not create link" }) };
    return { statusCode: 200, headers: H, body: JSON.stringify({ url: link.data.url }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
