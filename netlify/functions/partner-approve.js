// HomegoingHQ — Approve a co-brand partner application (admin-only).
// If the owner has no account yet, creates one via the Supabase Admin API (the
// handle_new_user trigger makes their profiles row), then provisions the co-brand
// account via admin_approve_partner_application and emails a set-password link.
// If the owner already has an account, it just provisions (the client sends the
// normal welcome email in that case).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SENDGRID_API_KEY, FROM_EMAIL, SITE_URL
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SB = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY;
  if (!SB || !SR || !ANON) return { statusCode: 500, headers, body: JSON.stringify({ error: "db not configured" }) };
  const site = process.env.SITE_URL || "https://app.homegoinghq.com";
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };

  const profileUid = async (email) => {
    const r = await fetch(SB + "/rest/v1/profiles?select=id&email=eq." + encodeURIComponent(email), { headers: SRH });
    const j = await r.json().catch(() => []);
    return Array.isArray(j) && j[0] ? j[0].id : null;
  };

  try {
    const { accessToken, id, subdomain } = JSON.parse(event.body || "{}");
    if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "application id required" }) };

    // 1) Verify the caller is a signed-in admin.
    const who = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    const ia = await fetch(SB + "/rest/v1/rpc/is_admin", { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, body: "{}" });
    if (!(ia.ok && (await ia.json()) === true)) return { statusCode: 403, headers, body: JSON.stringify({ error: "admin only" }) };

    // 2) Load the application (service role).
    const apps = await (await fetch(SB + "/rest/v1/partner_applications?select=*&id=eq." + encodeURIComponent(id), { headers: SRH })).json();
    const app = Array.isArray(apps) && apps[0];
    if (!app) return { statusCode: 200, headers, body: JSON.stringify({ error: "not_found" }) };
    if (app.status === "approved") return { statusCode: 200, headers, body: JSON.stringify({ error: "already_approved" }) };
    const email = (app.owner_email || "").toLowerCase();

    // 3) Ensure the owner has an account.
    let uid = await profileUid(email);
    let created = false, actionLink = null;
    if (!uid) {
      // Create the auth user (confirmed, no password). Trigger creates profiles.
      await fetch(SB + "/auth/v1/admin/users", {
        method: "POST", headers: SRH,
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: app.contact_name || app.business_name || "" } })
      }); // ignore "already registered" — generate_link below still works
      created = true;
      for (let i = 0; i < 6 && !uid; i++) { await sleep(400); uid = await profileUid(email); }
      if (!uid) return { statusCode: 200, headers, body: JSON.stringify({ error: "account_pending", created: true }) };
    }

    // 4) Provision + mark approved (runs as the admin, so is_admin() passes).
    const pr = await fetch(SB + "/rest/v1/rpc/admin_approve_partner_application", {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ p_id: id, p_subdomain: subdomain || null })
    });
    const res = await pr.json().catch(() => ({}));
    if (res && res.error) return { statusCode: 200, headers, body: JSON.stringify({ error: res.error, created }) };

    // 5) New account → email a set-password link (branded). Existing account → the
    //    client sends the normal welcome email.
    if (created && process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL) {
      const gl = await fetch(SB + "/auth/v1/admin/generate_link", {
        method: "POST", headers: SRH,
        body: JSON.stringify({ type: "recovery", email, redirect_to: site })
      });
      const gj = await gl.json().catch(() => ({}));
      actionLink = gj.action_link || (gj.properties && gj.properties.action_link) || null;

      const sub = (subdomain || app.desired_subdomain || "").toString().replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const branded = sub ? ("https://" + sub + ".homegoinghq.com") : site;
      const biz = (app.business_name || "your organization").replace(/</g, "&lt;");
      const isChurch = app.tenant_type === "church";
      const who = isChurch ? "your congregation" : "the families you serve";
      const html = `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">Welcome — your HomegoingHQ portal is ready</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
          <p style="font-size:15px;line-height:1.6">Welcome, <strong>${biz}</strong> — you're approved. Your co-branded aftercare portal is set up, and ${who} will see it as <em>“Aftercare provided by ${biz}, with HomegoingHQ.”</em></p>
          <p style="font-size:14px;line-height:1.6">First, set your password to sign in:</p>
          <p style="margin:20px 0;text-align:center">${actionLink
            ? `<a href="${actionLink}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Set your password →</a>`
            : `<a href="${site}" style="color:#8F6A24">Set your password at ${site}</a> (use “Forgot your password?” with this email)`}</p>
          <p style="font-size:14px;line-height:1.6">Your branded space:</p>
          <p style="text-align:center;margin:0 0 16px"><a href="${branded}" style="font-family:Arial,sans-serif;color:#8F6A24;word-break:break-all">${branded}</a></p>
          <p style="font-size:13px;line-height:1.6;color:#5B7183">After signing in, add your logo and colors under your account's branding settings. Families never pay you for the platform — they choose their own plan directly, and everything stays under your name.</p>
          <p style="font-size:12.5px;color:#5B7183">Questions? <a href="mailto:care@homegoinghq.com" style="color:#8F6A24">care@homegoinghq.com</a></p>
        </div></div>`;

      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
          subject: "You're approved — set your HomegoingHQ password",
          content: [{ type: "text/html", value: html }]
        })
      }).catch(() => {});
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, created }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
