// HomegoingHQ — record a family's rating for their designer and recompute the designer's average.
// Runs server-side (service role) because a family can't read the whole designer roster.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: "not configured" }) };
  const sh = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };
  try {
    const { orderId, rating, comment } = JSON.parse(event.body || "{}");
    const r = Math.max(1, Math.min(5, parseInt(rating) || 0));
    if (!orderId || !r) return { statusCode: 400, headers, body: JSON.stringify({ error: "orderId and rating required" }) };

    // 1) Save the rating on the order.
    await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId), {
      method: "PATCH", headers: { ...sh, "Prefer": "return=representation" },
      body: JSON.stringify({ rating: r, rating_comment: (comment || "").slice(0, 1000) || null, rated_at: new Date().toISOString() })
    });

    // 2) Find the designer on this order.
    const oR = await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId) + "&select=assigned_designer_id", { headers: sh });
    const oRows = await oR.json();
    const designerId = oRows && oRows[0] && oRows[0].assigned_designer_id;
    if (!designerId) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, note: "no designer to aggregate" }) };

    // 3) Recompute that designer's average rating + completed count.
    const aR = await fetch(SB + "/rest/v1/fullservice_requests?assigned_designer_id=eq." + encodeURIComponent(designerId) + "&select=rating,status", { headers: sh });
    const rows = await aR.json();
    const rated = (rows || []).filter(x => x.rating);
    const avg = rated.length ? Math.round((rated.reduce((s, x) => s + x.rating, 0) / rated.length) * 10) / 10 : null;
    const completed = (rows || []).filter(x => x.status === "balance_paid" || x.status === "shipped").length;

    await fetch(SB + "/rest/v1/designers?id=eq." + encodeURIComponent(designerId), {
      method: "PATCH", headers: { ...sh, "Prefer": "return=minimal" },
      body: JSON.stringify({ rating: avg, completed_count: completed, updated_at: new Date().toISOString() })
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, avg, completed }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
