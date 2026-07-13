// HomegoingHQ — Send a provider decision email (acceptance / denial) via SendGrid.
// Sends the exact subject/body composed in the credentialing dashboard.
// Env: SENDGRID_API_KEY (already set for send-invite),
//      SENDGRID_FROM (optional — the verified sender; defaults to care@homegoinghq.com)

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };

  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: "not configured" }) };

  let to = "", subject = "", body = "";
  try { const b = JSON.parse(event.body || "{}"); to = (b.to || "").trim(); subject = (b.subject || "").trim(); body = (b.body || "").toString(); } catch (e) {}
  if (!to || !subject || !body) return { statusCode: 400, body: JSON.stringify({ error: "missing to, subject, or body" }) };

  const from = process.env.SENDGRID_FROM || "care@homegoinghq.com";
  const html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

  try {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: "HomegoingHQ" },
        reply_to: { email: from },
        subject,
        content: [{ type: "text/plain", value: body }, { type: "text/html", value: html }]
      })
    });
    if (r.status >= 200 && r.status < 300) return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    const detail = await r.text().catch(() => "");
    return { statusCode: 502, body: JSON.stringify({ error: "send failed", status: r.status, detail: detail.slice(0, 200) }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
