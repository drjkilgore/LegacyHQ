// LegacyHQ — Stripe Checkout session creator
// Env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_SETTLE (one-time), STRIPE_PRICE_PREMIUM (subscription), SITE_URL
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { tier, userId, email } = JSON.parse(event.body || "{}");
    const isSub = tier === "premium";
    const price = isSub ? process.env.STRIPE_PRICE_PREMIUM : process.env.STRIPE_PRICE_SETTLE;
    if (!price) return { statusCode: 400, headers, body: JSON.stringify({ error: "Price not configured" }) };

    const params = new URLSearchParams();
    params.append("mode", isSub ? "subscription" : "payment");
    params.append("line_items[0][price]", price);
    params.append("line_items[0][quantity]", "1");
    params.append("success_url", (process.env.SITE_URL || "") + "/?billing=success");
    params.append("cancel_url", (process.env.SITE_URL || "") + "/?billing=cancelled");
    params.append("customer_email", email || "");
    params.append("client_reference_id", userId || "");
    params.append("metadata[user_id]", userId || "");
    params.append("metadata[tier]", tier || "settle");

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: data.error?.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
