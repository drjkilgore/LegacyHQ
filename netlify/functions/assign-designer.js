// HomegoingHQ — assign an approved designer to an order (round-robin by state).
// Runs server-side with the service role because families can't read the designer roster.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and optionally SENDGRID_API_KEY + SENDGRID_FROM.
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !KEY) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, skipped: "no service role configured" }) };
  const sh = { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" };

  try {
    const { orderId, state, designerId } = JSON.parse(event.body || "{}");
    if (!orderId) return { statusCode: 400, headers, body: JSON.stringify({ error: "orderId required" }) };
    const st = (state || "").toUpperCase().trim();

    // Skip designers who already passed on this order.
    let declined = [];
    try {
      const or = await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId) + "&select=declined_by", { headers: sh });
      const oj = await or.json();
      if (Array.isArray(oj) && oj[0] && Array.isArray(oj[0].declined_by)) declined = oj[0].declined_by;
    } catch (e) {}

    // 1) Eligible designers: approved, not offline/on vacation, serving this state — oldest rotation first.
    async function pick(filterState) {
      let url = SB + "/rest/v1/designers?status=eq.approved&availability=in.(available,busy)"
        + "&order=last_assigned_at.asc.nullsfirst&limit=1&select=id,full_name,email,states";
      if (filterState) url += "&states=cs.{" + encodeURIComponent(filterState) + "}";
      if (declined.length) url += "&id=not.in.(" + declined.map(encodeURIComponent).join(",") + ")";
      const r = await fetch(url, { headers: sh });
      const rows = await r.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    let designer = null, scope = "state";
    if (designerId) { // family chose a specific designer
      const r = await fetch(SB + "/rest/v1/designers?id=eq." + encodeURIComponent(designerId) + "&status=eq.approved&select=id,full_name,email,states", { headers: sh });
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) { designer = rows[0]; scope = "chosen"; }
    }
    if (!designer && st) { designer = await pick(st); if (designer) scope = "state"; }
    if (!designer) { designer = await pick(null); if (designer) scope = "any"; } // fallback: national

    if (!designer) {
      // No one available — leave unassigned; the admin queue still shows it.
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, assigned: false, reason: "no available designer" }) };
    }

    const now = new Date().toISOString();
    // 2) Assign the order.
    await fetch(SB + "/rest/v1/fullservice_requests?id=eq." + encodeURIComponent(orderId), {
      method: "PATCH", headers: { ...sh, "Prefer": "return=minimal" },
      body: JSON.stringify({ assigned_designer_id: designer.id, assignment_status: "pending", updated_at: now })
    });
    // 3) Advance the designer's rotation pointer.
    await fetch(SB + "/rest/v1/designers?id=eq." + encodeURIComponent(designer.id), {
      method: "PATCH", headers: { ...sh, "Prefer": "return=minimal" },
      body: JSON.stringify({ last_assigned_at: now })
    });

    // 4) Notify the designer (best-effort).
    if (process.env.SENDGRID_API_KEY && designer.email) {
      const from = process.env.SENDGRID_FROM || "care@homegoinghq.com";
      const site = process.env.SITE_URL || "";
      const body = "You've been assigned a new HomegoingHQ design order"
        + (scope === "any" ? " (national routing)" : (st ? " in " + st : ""))
        + ".\n\nOpen your Designer Portal to view it: " + (site || "your HomegoingHQ portal") + "\n\nThank you.";
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: designer.email }] }],
          from: { email: from, name: "HomegoingHQ" },
          subject: "New design assignment",
          content: [{ type: "text/plain", value: body }]
        })
      }).catch(() => {});
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, assigned: true, scope, designer: { id: designer.id, name: designer.full_name } }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
