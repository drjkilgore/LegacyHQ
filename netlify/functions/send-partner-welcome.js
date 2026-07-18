// HomegoingHQ — Co-brand partner welcome email (funeral homes & churches).
// Called right after admin_provision_partner succeeds. Looks the account up in
// Supabase (service role) so it can ONLY email a real, provisioned partner — the
// client just passes the owner email; everything shown is derived from the DB.
// Env vars: SENDGRID_API_KEY, FROM_EMAIL, SITE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) return { statusCode: 200, headers, body: JSON.stringify({ skipped: "email not configured" }) };

  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !KEY) return { statusCode: 200, headers, body: JSON.stringify({ skipped: "db not configured" }) };

  try {
    const { email } = JSON.parse(event.body || "{}");
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };
    const H = { apikey: KEY, Authorization: "Bearer " + KEY };

    // Resolve owner → account. Only send for a real co-brand account.
    const pr = await (await fetch(SB + "/rest/v1/profiles?select=id&email=eq." + encodeURIComponent(email.toLowerCase()), { headers: H })).json();
    const uid = Array.isArray(pr) && pr[0] && pr[0].id;
    if (!uid) return { statusCode: 200, headers, body: JSON.stringify({ skipped: "no such user" }) };

    const acc = await (await fetch(SB + "/rest/v1/concierge_accounts?select=business_name,subdomain,custom_domain,tenant_type&owner_user_id=eq." + uid, { headers: H })).json();
    const a = Array.isArray(acc) && acc[0];
    if (!a || (a.tenant_type !== "funeral_home" && a.tenant_type !== "church")) {
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: "not a co-brand partner" }) };
    }

    const site = process.env.SITE_URL || "https://app.homegoinghq.com";
    const link = a.custom_domain ? ("https://" + a.custom_domain)
               : a.subdomain ? ("https://" + a.subdomain + ".homegoinghq.com")
               : site;
    const biz = (a.business_name || "your organization").replace(/</g, "&lt;");
    const isChurch = a.tenant_type === "church";
    const kindWord = isChurch ? "congregation" : "families";
    const useLine = isChurch
      ? `Share it with anyone in your congregation walking through a loss — they'll find the guided roadmap, the memorial tools, and a calm place to keep what matters, under your church's name.`
      : `Add it to your arrangement conference, your website, and your aftercare follow-ups. Every family who enters through this link gets the full guided platform under your funeral home's name.`;

    const html = `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
      <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">Your HomegoingHQ portal is ready</div>
      <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
        <p style="font-size:15px;line-height:1.6">Welcome, <strong>${biz}</strong> — your co-branded aftercare portal is live. ${kindWord === "congregation" ? "Your congregation" : "The families you serve"} will see it as <em>“Aftercare provided by ${biz}, with HomegoingHQ.”</em></p>
        <p style="font-size:14px;margin:18px 0 6px">Your branded link:</p>
        <p style="text-align:center;margin:0 0 18px"><a href="${link}" style="font-family:Arial,sans-serif;font-size:16px;color:#8F6A24;word-break:break-all">${link}</a></p>
        <p style="font-size:14px;line-height:1.6">${useLine}</p>
        <p style="font-size:14px;line-height:1.6">To finish setup, sign in and add your logo and colors under your account's branding settings. Families never pay you for the platform — they choose their own plan directly, and everything stays under your name.</p>
        <p style="margin:22px 0"><a href="${site}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Sign in to finish setup</a></p>
        <p style="font-size:12.5px;color:#5B7183">Questions? We're here: <a href="mailto:care@homegoinghq.com" style="color:#8F6A24">care@homegoinghq.com</a>.</p>
      </div></div>`;

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
        subject: (isChurch ? "Your church's" : "Your funeral home's") + " HomegoingHQ portal is ready",
        content: [{ type: "text/html", value: html }]
      })
    });
    return { statusCode: resp.ok ? 200 : 502, headers, body: JSON.stringify({ sent: resp.ok, link }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
