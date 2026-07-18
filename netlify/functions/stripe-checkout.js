// HomegoingHQ — Stripe Checkout session creator
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
    const { tier, userId, email, estateId, recipientEmail, giftMessage, business } = JSON.parse(event.body || "{}");
    const isGift = tier === "gift_settle";
    const isVault = tier === "vault";                 // ongoing document-vault subscription ($8/mo)
    const isFuneralHome = tier === "funeralhome";     // co-brand partner subscription ($149/mo)
    const isSub = tier === "premium" || isVault || isFuneralHome;
    const price = isVault ? process.env.STRIPE_PRICE_VAULT
                : isFuneralHome ? process.env.STRIPE_PRICE_FUNERALHOME
                : tier === "premium" ? process.env.STRIPE_PRICE_PREMIUM
                : tier === "companion" ? process.env.STRIPE_PRICE_COMPANION
                : process.env.STRIPE_PRICE_SETTLE;
    if (!price) return { statusCode: 400, headers, body: JSON.stringify({ error: "Price not configured" }) };

    const params = new URLSearchParams();
    params.append("mode", isSub ? "subscription" : "payment");
    params.append("line_items[0][price]", price);
    params.append("line_items[0][quantity]", "1");
    params.append("success_url", (process.env.SITE_URL || "") + (isVault ? "/?billing=vault" : isFuneralHome ? "/?partner=success" : "/?billing=success"));
    params.append("cancel_url", (process.env.SITE_URL || "") + (isVault ? "/?billing=vault_cancelled" : isFuneralHome ? "/?partner=cancelled" : "/?billing=cancelled"));
    if (email) params.append("customer_email", email);
    if (userId) params.append("client_reference_id", userId);
    if (userId) params.append("metadata[user_id]", userId);
    params.append("metadata[tier]", isGift ? "gift_settle" : (tier || "settle"));
    if (estateId) params.append("metadata[estate_id]", estateId);
    if (isFuneralHome) {
      params.append("metadata[tenant_type]", "funeral_home");
      if (business) params.append("metadata[business_name]", String(business).slice(0, 120));
    }
    if (isGift) {
      params.append("metadata[recipient_email]", recipientEmail || "");
      params.append("metadata[gift_message]", (giftMessage || "").slice(0, 400));
      params.append("metadata[purchaser_email]", email || "");
    }

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
