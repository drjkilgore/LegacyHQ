// ============================================================================
// Netlify Function: keepsakes-checkout
// Creates a Stripe Checkout session for a keepsakes cart. Because keepsake
// prices are dynamic (and carry a customer image + recipient), we:
//   1) write the full order to Supabase (keepsake_orders, status "pending")
//   2) create a Stripe session with dynamic price_data line items (RETAIL)
//   3) stash ONLY the order id in metadata (Stripe metadata is size-capped)
// On payment, keepsakes-webhook reads the row and places the Prodigi order.
//
// Env vars: STRIPE_SECRET_KEY, SITE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Request (POST JSON):
//   { items:[{sku,name,retail,wholesale,copies,printArea,imageUrl,sizing}],
//     recipient:{name,email,address:{line1,line2,townOrCity,stateOrCounty,postalOrZipCode,countryCode}},
//     shippingMethod?, buyerEmail?, note? }
// Response: { url }
// ============================================================================

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SK = process.env.STRIPE_SECRET_KEY;
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SK) return { statusCode: 500, headers, body: JSON.stringify({ error: "STRIPE_SECRET_KEY not set" }) };
  if (!SB || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase env not set" }) };

  try {
    const b = JSON.parse(event.body || "{}");
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "cart is empty" }) };
    if (!b.recipient || !b.recipient.address || !b.recipient.address.line1)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "recipient delivery address required" }) };

    // require an uploaded image for any item flagged as personalizable
    for (const i of items) {
      if (i.needsPhoto && !i.imageUrl)
        return { statusCode: 400, headers, body: JSON.stringify({ error: `photo required for "${i.name}"` }) };
    }

    const retailTotal = items.reduce((s, i) => s + (Number(i.retail) || 0) * (i.copies || 1), 0);
    const wholesaleTotal = items.reduce((s, i) => s + (Number(i.wholesale) || 0) * (i.copies || 1), 0);

    // 1) persist the order (source of truth for the webhook)
    const orderRow = {
      status: "pending",
      buyer_email: b.buyerEmail || b.recipient.email || null,
      shipping_method: b.shippingMethod || "Budget",
      recipient: b.recipient,
      items,                       // includes sku, imageUrl, printArea, copies, sizing
      note: (b.note || "").slice(0, 500) || null,
      retail_total: Math.round(retailTotal * 100) / 100,
      wholesale_total: Math.round(wholesaleTotal * 100) / 100,
      margin_total: Math.round((retailTotal - wholesaleTotal) * 100) / 100,
    };
    const ins = await fetch(SB + "/rest/v1/keepsake_orders", {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(orderRow),
    });
    if (!ins.ok) {
      const t = await ins.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: "could not save order", detail: t.slice(0, 300) }) };
    }
    const saved = (await ins.json())[0];
    const orderId = saved.id;

    // 2) Stripe session with dynamic line items at RETAIL
    const params = new URLSearchParams();
    params.append("mode", "payment");
    items.forEach((i, n) => {
      params.append(`line_items[${n}][price_data][currency]`, "usd");
      params.append(`line_items[${n}][price_data][product_data][name]`, i.name || "Keepsake");
      params.append(`line_items[${n}][price_data][unit_amount]`, String(Math.round(Number(i.retail) * 100)));
      params.append(`line_items[${n}][quantity]`, String(i.copies || 1));
    });
    params.append("success_url", (process.env.SITE_URL || "") + "/?keepsake=success&ko=" + orderId);
    params.append("cancel_url", (process.env.SITE_URL || "") + "/?keepsake=cancelled");
    if (orderRow.buyer_email) params.append("customer_email", orderRow.buyer_email);
    params.append("metadata[kind]", "keepsake_order");
    params.append("metadata[order_id]", String(orderId));

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + SK, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: data.error?.message }) };

    // link the Stripe session back to the order (best-effort)
    await fetch(SB + "/rest/v1/keepsake_orders?id=eq." + orderId, {
      method: "PATCH",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ stripe_session_id: data.id }),
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url, orderId }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
