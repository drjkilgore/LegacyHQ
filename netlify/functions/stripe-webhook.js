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
    // Fail CLOSED: without the signing secret we cannot trust the event, so refuse it.
    if (!secret) { console.error("[stripe-webhook] REJECT: STRIPE_WEBHOOK_SECRET is not set in Netlify"); return { statusCode: 400, body: "webhook secret not configured" }; }
    const sigHeader = event.headers["stripe-signature"];
    if (!sigHeader) { console.error("[stripe-webhook] REJECT: no stripe-signature header (is this really Stripe calling this URL?)"); return { statusCode: 400, body: "missing signature header" }; }
    const ok = verifyStripeSignature(event.body, sigHeader, secret);
    if (!ok) {
      console.error(`[stripe-webhook] REJECT: invalid signature -- starts_with_whsec=${secret.startsWith("whsec_")} secret_len=${secret.length}. If starts_with_whsec is false, the wrong Stripe value was copied (need the endpoint Signing secret, not an API key). For live sales, use the LIVE endpoint's secret.`);
      return { statusCode: 400, body: "invalid signature" };
    }
    console.log("[stripe-webhook] signature verified \u2713");

    const body = JSON.parse(event.body || "{}");
    console.log("[stripe-webhook] event:", body.type);

    // ---- VAULT KEEPER lifecycle: keep vault_status / vault_grace_until in sync ----
    // Matched strictly by vault_subscription_id, so concierge subs are never touched.
    // Cancel or failed payment opens a 45-day grace window; the sweep function
    // deletes documents only after that window lapses.
    if (["customer.subscription.deleted","customer.subscription.updated",
         "invoice.payment_failed","invoice.payment_succeeded"].includes(body.type)) {
      const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SB || !KEY) return { statusCode: 200, body: "vault: not configured" };
      const H = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };
      const obj = body.data.object;
      const subId = obj.subscription || obj.id;   // invoices carry .subscription; subscription events use .id
      if (!subId) return { statusCode: 200, body: "vault: no sub id" };

      const pr = await fetch(SB + "/rest/v1/profiles?vault_subscription_id=eq." + encodeURIComponent(subId) +
        "&select=id,vault_status,vault_grace_until", { headers: H });
      const rows = await pr.json();
      const prof = Array.isArray(rows) && rows[0];
      if (!prof) return { statusCode: 200, body: "vault: no matching profile" };

      const graceISO = new Date(Date.now() + 45 * 864e5).toISOString();   // 45-day window
      const keepGrace = prof.vault_grace_until || graceISO;               // don't extend an existing deadline
      let patch = null;
      if (body.type === "invoice.payment_succeeded") {
        patch = { vault_status: "active", vault_grace_until: null };
      } else if (body.type === "invoice.payment_failed") {
        patch = { vault_status: "past_due", vault_grace_until: keepGrace };
      } else if (body.type === "customer.subscription.deleted") {
        patch = { vault_status: "canceled", vault_grace_until: keepGrace };
      } else { // customer.subscription.updated
        const s = obj.status;
        if (s === "active" || s === "trialing") patch = { vault_status: "active", vault_grace_until: null };
        else if (s === "past_due" || s === "unpaid") patch = { vault_status: "past_due", vault_grace_until: keepGrace };
        else if (s === "canceled" || s === "incomplete_expired") patch = { vault_status: "canceled", vault_grace_until: keepGrace };
        if (patch && obj.current_period_end) patch.vault_current_period_end = new Date(obj.current_period_end * 1000).toISOString();
      }
      if (patch) {
        await fetch(SB + "/rest/v1/profiles?id=eq." + encodeURIComponent(prof.id), {
          method: "PATCH", headers: { ...H, "Prefer": "return=minimal" }, body: JSON.stringify(patch)
        });
      }
      return { statusCode: 200, body: "vault sync: " + body.type };
    }

    if (body.type !== "checkout.session.completed") return { statusCode: 200, body: "ignored" };

    const session = body.data.object;

    // Keepsakes orders are fulfilled by keepsakes-webhook (Prodigi). Never let
    // them fall through to billing logic and touch a buyer's plan tier.
    if (session.metadata?.kind === "keepsake_order") return { statusCode: 200, body: "keepsake handled elsewhere" };

    const tier = session.metadata?.tier || "settle";

    // ---- FULL-SERVICE design fee / printing balance: update the order's status ----
    const fsKind = session.metadata?.kind;
    if (fsKind === "fullservice_design_fee" || fsKind === "fullservice_balance") {
      const orderId = session.metadata?.order_id;
      const newStatus = fsKind === "fullservice_balance" ? "balance_paid" : "design_fee_paid";
      if (orderId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const sbHeaders = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };
        await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId), {
          method: "PATCH",
          headers: { ...sbHeaders, "Prefer": "return=minimal" },
          body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
        });

        // On BALANCE paid, the job is done → credit the assigned designer's share
        // of the design fee (printing is not shared). Unique(order_id) prevents
        // double-crediting if the webhook is retried.
        if (fsKind === "fullservice_balance") {
          try {
            const oResp = await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId) +
              "&select=assigned_designer_id,design_fee", { headers: sbHeaders });
            const oRows = await oResp.json();
            const order = Array.isArray(oRows) ? oRows[0] : null;
            if (order && order.assigned_designer_id && Number(order.design_fee) > 0) {
              let rate = 0.70;
              const dResp = await fetch(SB + "/rest/v1/designers?id=eq." +
                encodeURIComponent(order.assigned_designer_id) + "&select=payout_rate", { headers: sbHeaders });
              const dRows = await dResp.json();
              if (Array.isArray(dRows) && dRows[0] && dRows[0].payout_rate != null) rate = Number(dRows[0].payout_rate);
              const fee = Number(order.design_fee);
              const amount = Math.round(fee * rate * 100) / 100;
              await fetch(SB + "/rest/v1/designer_payouts", {
                method: "POST",
                headers: { ...sbHeaders, "Prefer": "resolution=ignore-duplicates,return=minimal" },
                body: JSON.stringify({
                  order_id: orderId, designer_id: order.assigned_designer_id,
                  design_fee: fee, rate, amount, status: "owed"
                })
              });
            }
          } catch (e) { /* payout credit is best-effort; status already updated */ }
        }
      }
      return { statusCode: 200, body: "fullservice " + newStatus };
    }

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

    // ---- VAULT KEEPER: activate ongoing document-vault access on the profile ----
    if (tier === "vault") {
      const owner = session.metadata?.user_id || session.client_reference_id;
      if (!owner) return { statusCode: 200, body: "no user" };
      const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const sbHeaders = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal" };
      const resp = await fetch(SB + "/rest/v1/profiles?id=eq." + encodeURIComponent(owner), {
        method: "PATCH", headers: sbHeaders,
        body: JSON.stringify({
          vault_status: "active",
          vault_grace_until: null,
          vault_subscription_id: session.subscription || null,
          stripe_customer_id: session.customer || undefined
        })
      });
      return { statusCode: resp.ok ? 200 : 500, body: resp.ok ? "vault active" : "supabase error" };
    }

    // ---- CO-BRAND PARTNER (funeral home) subscription: provision an unlimited,
    // co-branded account by email. provision_by_email forwards tenant_type, and
    // migration v24's trigger forces the unlimited family cap. Subdomain/branding
    // are set afterward in the admin panel (or by the owner). ----
    if (session.metadata?.tenant_type === "funeral_home" || tier === "funeralhome") {
      const email = session.customer_details?.email || session.metadata?.owner_email;
      if (!email) return { statusCode: 200, body: "no email" };
      const rpc = await fetch(process.env.SUPABASE_URL + "/rest/v1/rpc/provision_by_email", {
        method: "POST",
        headers: {
          "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_email: email,
          p_tier: "professional",                       // placeholder; v24 trigger forces unlimited
          p_business: session.metadata?.business_name || "",
          p_ref: session.subscription || null,
          p_tenant_type: "funeral_home"
        })
      });
      return { statusCode: rpc.ok ? 200 : 500, body: rpc.ok ? "funeral home provisioned" : "provision error" };
    }

    const userId = session.metadata?.user_id || session.client_reference_id;
    if (!userId) return { statusCode: 200, body: "no user" };

    const estateId = session.metadata?.estate_id;
    const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbHeaders = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal" };

    // Companion / Settle are PER-ESTATE: stamp the estate's tier.
    // Premium (subscription) stays a per-user grant on the profile.
    if (estateId && (tier === "companion" || tier === "settle")) {
      const resp = await fetch(SB + "/rest/v1/estates?id=eq." + encodeURIComponent(estateId), {
        method: "PATCH", headers: sbHeaders,
        body: JSON.stringify({ tier })
      });
      // record the customer on the profile too (for receipts), without changing plan_tier
      if (session.customer) {
        await fetch(SB + "/rest/v1/profiles?id=eq." + userId, {
          method: "PATCH", headers: sbHeaders,
          body: JSON.stringify({ stripe_customer_id: session.customer })
        });
      }
      return { statusCode: resp.ok ? 200 : 500, body: resp.ok ? "estate " + tier : "supabase error" };
    }

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
