// netlify/functions/log-consent.js
// Records cookie-consent events to Supabase (server-side, service role).
// Env vars required in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (no bad chars in this filename — safe for netlify/functions/)

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: "Server not configured" };
  }

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: "Bad JSON" }; }

  var h = event.headers || {};
  var ip = (h["x-nf-client-connection-ip"] ||
            (h["x-forwarded-for"] || "").split(",")[0] || "").trim() || null;

  var row = {
    consent_id: body.consent_id || null,
    account_id: body.account_id || null,
    choice: body.choice || null,
    functional: !!body.functional,
    analytics: !!body.analytics,
    advertising: !!body.advertising,
    policy_version: body.policy_version || null,
    gpc: !!body.gpc,
    user_agent: (body.user_agent || "").slice(0, 500),
    ip_address: ip,
    created_at: body.ts || new Date().toISOString()
  };

  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/cookie_consents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      var txt = await res.text();
      return { statusCode: 502, body: "Insert failed: " + txt.slice(0, 300) };
    }
    return { statusCode: 204, body: "" };
  } catch (e) {
    return { statusCode: 502, body: "Upstream error" };
  }
};
