// ============================================================================
// Netlify Function: keepsakes-webhook
// A SEPARATE Stripe webhook endpoint dedicated to keepsake orders, so your
// core billing webhook (stripe-webhook.js) stays untouched. Point a second
// Stripe endpoint at /.netlify/functions/keepsakes-webhook for the event
// checkout.session.completed. It ignores everything except keepsake orders.
//
// On a paid keepsake order it:
//   1) loads the keepsake_orders row (written by keepsakes-checkout)
//   2) places the Prodigi order (customer image URLs as print assets)
//   3) saves the Prodigi order id + status back to the row
// You collected retail via Stripe; you now pay Prodigi wholesale. Spread = margin.
//
// Env vars:
//   STRIPE_KEEPSAKES_WEBHOOK_SECRET   signing secret for THIS endpoint (whsec_…)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PRODIGI_API_KEY, PRODIGI_BASE (defaults to sandbox — flip for live orders)
// ============================================================================

const crypto = require("crypto");
const PRODIGI_BASE = (process.env.PRODIGI_BASE || "https://api.sandbox.prodigi.com/v4.0/").replace(/\/?$/, "/");

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t, sig = parts.v1;
  if (!timestamp || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex")); } catch { return false; }
}

exports.handler = async (event) => {
  try {
    const secret = process.env.STRIPE_KEEPSAKES_WEBHOOK_SECRET;
    if (secret) {
      const ok = verifyStripeSignature(event.body, event.headers["stripe-signature"], secret);
      if (!ok) return { statusCode: 400, body: "invalid signature" };
    } // if unset (test phase) events are accepted unverified — set it before real sales

    const body = JSON.parse(event.body || "{}");
    if (body.type !== "checkout.session.completed") return { statusCode: 200, body: "ignored" };

    const session = body.data.object;
    if (session.metadata?.kind !== "keepsake_order") return { statusCode: 200, body: "not a keepsake order" };

    const orderId = session.metadata?.order_id;
    const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!orderId || !SB || !KEY) return { statusCode: 200, body: "missing order id / supabase" };
    const sbHeaders = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

    // load the order
    const oResp = await fetch(SB + "/rest/v1/keepsake_orders?id=eq." + encodeURIComponent(orderId) + "&select=*", { headers: sbHeaders });
    const rows = await oResp.json();
    const order = Array.isArray(rows) ? rows[0] : null;
    if (!order) return { statusCode: 200, body: "order not found" };

    // idempotency: if we already placed it, stop (webhook retries are normal)
    if (order.prodigi_order_id) return { statusCode: 200, body: "already fulfilled" };

    // mark paid first
    await fetch(SB + "/rest/v1/keepsake_orders?id=eq." + orderId, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
    });

    // build + place the Prodigi order
    const key = process.env.PRODIGI_API_KEY;
    if (!key) return { statusCode: 200, body: "paid; PRODIGI_API_KEY not set — place manually" };

    const items = (order.items || []).map((i) => ({
      merchantReference: i.sku,
      sku: i.sku,
      copies: i.copies || 1,
      sizing: i.sizing || "fillPrintArea",
      attributes: i.attributes || {},
      assets: i.imageUrl ? [{ printArea: i.printArea || "default", url: i.imageUrl }] : [],
    }));

    const prodigiPayload = {
      merchantReference: "KEEPSAKE-" + orderId,
      shippingMethod: order.shipping_method || "Budget",
      recipient: order.recipient,
      items,
      metadata: { source: "HomegoingHQ Keepsakes", keepsake_order_id: orderId },
    };

    const pResp = await fetch(PRODIGI_BASE + "Orders", {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(prodigiPayload),
    });
    const pText = await pResp.text();
    let pData; try { pData = JSON.parse(pText); } catch { pData = { raw: pText.slice(0, 400) }; }

    if (!pResp.ok) {
      await fetch(SB + "/rest/v1/keepsake_orders?id=eq." + orderId, {
        method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "prodigi_error", prodigi_error: JSON.stringify(pData).slice(0, 500) }),
      });
      return { statusCode: 200, body: "paid; prodigi error logged" };
    }

    const prodigiId = pData.order?.id || pData.id || null;
    const prodigiStatus = pData.order?.status?.stage || "InProgress";
    await fetch(SB + "/rest/v1/keepsake_orders?id=eq." + orderId, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "submitted", prodigi_order_id: prodigiId, prodigi_status: prodigiStatus }),
    });

    return { statusCode: 200, body: "keepsake submitted to Prodigi" };
  } catch (err) {
    return { statusCode: 400, body: err.message };
  }
};
