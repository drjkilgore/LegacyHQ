// ============================================================================
// Netlify Function: prodigi-api
// Server-side proxy to the Prodigi Print API (v4). Injects your X-API-Key so
// the credential NEVER reaches the browser. Mirrors the flower-api.js pattern.
// Dependency-free: global fetch + built-ins only.
//
// Env vars:
//   PRODIGI_API_KEY     your Prodigi API key (from Prodigi dashboard → API)
//   PRODIGI_BASE        optional. Defaults to SANDBOX so nothing is charged or
//                       printed until you flip it. For real orders set:
//                       https://api.prodigi.com/v4.0/
//
// Request (POST JSON): { action, ...params }
//   action "quote"      { items:[{sku,copies,attributes?}], shippingMethod?, destinationCountryCode? }
//                        -> Prodigi cost so you can confirm wholesale before charging
//   action "placeorder" { merchantReference, shippingMethod, recipient, items }
//                        -> creates the order at the fulfilment lab
//   action "orderinfo"  { orderId }   -> live order/shipment status
//
// NOTE: customers never pay Prodigi. You collect retail via Stripe; this proxy
// places the order and you pay Prodigi wholesale. The spread is your margin.
// ============================================================================

const BASE = (process.env.PRODIGI_BASE || "https://api.sandbox.prodigi.com/v4.0/").replace(/\/?$/, "/");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.PRODIGI_API_KEY;
  if (!key) return json(500, { error: "PRODIGI_API_KEY not set" });

  try {
    const b = JSON.parse(event.body || "{}");
    let url, method = "GET", payload = null;

    switch (b.action) {
      case "quote": {
        url = BASE + "quotes";
        method = "POST";
        payload = JSON.stringify({
          shippingMethod: b.shippingMethod || "Budget",
          destinationCountryCode: b.destinationCountryCode || "US",
          items: (b.items || []).map((i) => ({
            sku: i.sku,
            copies: i.copies || 1,
            attributes: i.attributes || {},
            assets: (i.assets || [{ printArea: "default" }]).map((a) => ({ printArea: a.printArea || "default" })),
          })),
        });
        break;
      }
      case "placeorder": {
        url = BASE + "Orders";
        method = "POST";
        payload = JSON.stringify({
          merchantReference: b.merchantReference || undefined,
          shippingMethod: b.shippingMethod || "Budget",
          recipient: b.recipient,
          items: (b.items || []).map((i) => ({
            merchantReference: i.merchantReference || undefined,
            sku: i.sku,
            copies: i.copies || 1,
            sizing: i.sizing || "fillPrintArea",
            attributes: i.attributes || {},
            assets: (i.assets || []).map((a) => ({ printArea: a.printArea || "default", url: a.url })),
          })),
          metadata: b.metadata || {},
        });
        break;
      }
      case "orderinfo": {
        url = BASE + "Orders/" + encodeURIComponent(String(b.orderId || ""));
        break;
      }
      default:
        return json(400, { error: "unknown action: " + b.action });
    }

    const resp = await fetch(url, {
      method,
      headers: { "X-API-Key": key, ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload,
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 600) }; }
    if (!resp.ok) return json(502, { error: "prodigi " + resp.status, detail: data });
    return json(200, data);
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }

  function json(statusCode, obj) {
    return { statusCode, headers, body: JSON.stringify(obj) };
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
