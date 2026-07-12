// HomegoingHQ — Stripe webhook with signature verification.
// Env vars: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Stripe → Developers → Webhooks → endpoint /.netlify/functions/stripe-webhook
// Event: checkout.session.completed. Copy the endpoint's "Signing secret" (whsec_...)
const crypto = require("crypto");

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const timestamp = parts.t, sig = parts.v1;
  if (!timestamp || !sig) return false;
  // reject events older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch { return false; }
}

exports.handler = async (event) => {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (secret) {
      const ok = verifyStripeSignature(event.body, event.headers["stripe-signature"], secret);
      if (!ok) return { statusCode: 400, body: "invalid signature" };
    } // if secret unset (test phase), events are accepted unverified — set it before real sales

    const body = JSON.parse(event.body || "{}");
    if (body.type !== "checkout.session.completed") return { statusCode: 200, body: "ignored" };

    const session = body.data.object;
    const tier = session.metadata?.tier || "settle";

    // ---- GIFT purchase: create a code and email both parties ----
    if (tier === "gift_settle") {
      const code = "GIFT-" + require("crypto").randomBytes(4).toString("hex").toUpperCase();
      const recipient = session.metadata?.recipient_email || "";
      const purchaser = session.metadata?.purchaser_email || session.customer_details?.email || "";
      await fetch(process.env.SUPABASE_URL + "/rest/v1/gift_codes", {
        method: "POST",
        headers: {
          "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json", "Prefer": "return=minimal"
        },
        body: JSON.stringify({ code, tier: "settle", purchaser_email: purchaser,
          recipient_email: recipient, message: session.metadata?.gift_message || null })
      });
      if (process.env.SENDGRID_API_KEY && (recipient || purchaser)) {
        const site = process.env.SITE_URL || "";
        const msg = session.metadata?.gift_message;
        const html = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#26332E">
          <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">A gift of a helping hand</div>
          <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
          <p style="font-size:15px;line-height:1.6">Someone who cares about you has given you HomegoingHQ Settle — a calm, guided system for handling everything after the loss of a loved one: every task, deadline, letter, and document in one place.</p>
          ${msg ? `<p style="font-style:italic;border-left:3px solid #A67C2E;padding-left:14px">"${msg.replace(/</g,"&lt;")}"</p>` : ""}
          <p style="font-size:15px">Your gift code:</p>
          <p style="font-family:monospace;font-size:22px;letter-spacing:2px;background:#F6F2EA;padding:12px 16px;border-radius:10px;text-align:center">${code}</p>
          <p style="font-size:14px">Create a free account, then choose "Redeem a gift code" on your home screen.</p>
          <p style="margin:22px 0"><a href="${site}" style="background:#A67C2E;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Open HomegoingHQ</a></p>
          </div></div>`;
        const tos = [];
        if (recipient) tos.push({ to: [{ email: recipient }] });
        if (purchaser && purchaser !== recipient) tos.push({ to: [{ email: purchaser }] });
        await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: tos,
            from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
            subject: "You've been given HomegoingHQ — a helping hand when it matters",
            content: [{ type: "text/html", value: html }] })
        });
      }
      return { statusCode: 200, body: "gift created" };
    }

    // ---- CONCIERGE white-label subscription: provision a tenant account ----
    // metadata.tier is one of concierge_starter | concierge_professional | concierge_enterprise
    if (typeof tier === "string" && tier.startsWith("concierge_")) {
      const owner = session.metadata?.user_id || session.client_reference_id;
      if (!owner) return { statusCode: 200, body: "no owner" };
      const rpc = await fetch(process.env.SUPABASE_URL + "/rest/v1/rpc/provision_concierge_account", {
        method: "POST",
        headers: {
          "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_owner: owner,
          p_tier: tier.replace("concierge_", ""),      // starter | professional | enterprise
          p_business: session.metadata?.business_name || "",
          p_subdomain: session.metadata?.subdomain || "",
          p_stripe_sub: session.subscription || null,
          p_tenant_type: session.metadata?.tenant_type || "concierge"
        })
      });
      return { statusCode: rpc.ok ? 200 : 500, body: rpc.ok ? "account provisioned" : "provision error" };
    }

    const userId = session.metadata?.user_id || session.client_reference_id;
    if (!userId) return { statusCode: 200, body: "no user" };

    const resp = await fetch(process.env.SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId, {
      method: "PATCH",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({ plan_tier: tier, stripe_customer_id: session.customer || null })
    });
    return { statusCode: resp.ok ? 200 : 500, body: resp.ok ? "ok" : "supabase error" };
  } catch (err) {
    return { statusCode: 400, body: err.message };
  }
};
