// HomegoingHQ — Weekly family digest (Netlify Scheduled Function; see netlify.toml)
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY, FROM_EMAIL, SITE_URL
exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, URL = process.env.SUPABASE_URL;
  if (!KEY || !URL || !process.env.SENDGRID_API_KEY) return { statusCode: 200, body: "digest skipped: not configured" };
  const H = { apikey: KEY, Authorization: "Bearer " + KEY };
  const q = async (path) => (await fetch(`${URL}/rest/v1/${path}`, { headers: H })).json();

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const twoWeeks = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const estates = await q("estates?select=id,decedent_name&limit=200");
  let sent = 0;

  for (const est of estates) {
    const done = await q(`tasks?estate_id=eq.${est.id}&status=eq.done&updated_at=gte.${weekAgo}&select=title&limit=10`);
    const next = await q(`tasks?estate_id=eq.${est.id}&status=eq.todo&due_at=lte.${twoWeeks}&order=due_at&select=title,due_at&limit=6`);
    if (!done.length && !next.length) continue;

    const members = await q(`estate_members?estate_id=eq.${est.id}&select=user_id`);
    if (!members.length) continue;
    const ids = members.map(m => `"${m.user_id}"`).join(",");
    const profiles = await q(`profiles?id=in.(${ids})&select=email`);
    const emails = profiles.map(p => p.email).filter(Boolean);
    if (!emails.length) continue;

    const li = a => a.map(x => `<li style="margin:4px 0">${x}</li>`).join("");
    const html = `
      <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:19px">HomegoingHQ · Weekly update</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
          <p style="font-size:15px">A quiet summary of where things stand for the estate of <strong>${est.decedent_name}</strong>.</p>
          ${done.length ? `<p style="font-weight:bold;margin:18px 0 6px">Completed this week</p><ul style="padding-left:20px;font-size:14px">${li(done.map(d => d.title))}</ul>` : ""}
          ${next.length ? `<p style="font-weight:bold;margin:18px 0 6px">Coming up</p><ul style="padding-left:20px;font-size:14px">${li(next.map(n => `${n.title}${n.due_at ? " — by " + n.due_at : ""}`))}</ul>` : ""}
          <p style="margin:24px 0 4px"><a href="${process.env.SITE_URL || ""}" style="background:#A67C2E;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold;font-size:13px">Open the roadmap</a></p>
          <p style="font-size:11px;color:#5B7183;margin-top:18px">You receive this because you're a member of this estate in HomegoingHQ.</p>
        </div>
      </div>`;

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: emails.map(e => ({ to: [{ email: e }] })),
        from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
        subject: `Weekly update — estate of ${est.decedent_name}`,
        content: [{ type: "text/html", value: html }]
      })
    });
    if (resp.ok) sent++;
  }
  return { statusCode: 200, body: `digests sent for ${sent} estates` };
};
