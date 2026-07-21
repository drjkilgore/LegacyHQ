// HomegoingHQ — weekly family digest (scale-optimized Scheduled Function; see netlify.toml).
// Bulk-fetches recent-done tasks, upcoming tasks, members, and profiles across all estates
// in a few queries (no per-estate N+1), then emails with bounded concurrency, capped per run.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY, FROM_EMAIL, SITE_URL,
//      optional DIGEST_MAX_PER_RUN.
exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, URL = process.env.SUPABASE_URL;
  if (!KEY || !URL || !process.env.SENDGRID_API_KEY) return { statusCode: 200, body: "digest skipped: not configured" };
  const H = { apikey: KEY, Authorization: "Bearer " + KEY };
  const q = async (path) => (await fetch(`${URL}/rest/v1/${path}`, { headers: H })).json();
  const MAX = Number(process.env.DIGEST_MAX_PER_RUN || 600);
  const CONCURRENCY = 8;

  const inFetch = async (table, col, ids, select, extra = "") => {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await q(`${table}?select=${select}&${col}=in.(${chunk.join(",")})${extra}`);
      if (Array.isArray(r)) out.push(...r);
    }
    return out;
  };

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const twoWeeks = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  let sent = 0;
  try {
    // 1) all estates (paginated)
    const estates = []; let offset = 0;
    while (true) {
      const page = await q(`estates?select=id,decedent_name&order=created_at&limit=1000&offset=${offset}`);
      if (!Array.isArray(page) || !page.length) break;
      estates.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
    }
    if (!estates.length) return { statusCode: 200, body: "no estates" };
    const estateIds = estates.map(e => e.id);

    // 2) bulk-fetch done + upcoming tasks and members across all estates
    const doneRows = await inFetch("tasks", "estate_id", estateIds, "estate_id,title,updated_at", `&status=eq.done&updated_at=gte.${weekAgo}&order=updated_at.desc`);
    const nextRows = await inFetch("tasks", "estate_id", estateIds, "estate_id,title,due_at", `&status=eq.todo&due_at=lte.${twoWeeks}&order=due_at`);
    const memRows  = await inFetch("estate_members", "estate_id", estateIds, "estate_id,user_id");

    // group tasks/members by estate (cap list lengths per estate)
    const doneBy = new Map(), nextBy = new Map(), memBy = new Map();
    for (const d of doneRows) { const a = doneBy.get(d.estate_id) || []; if (a.length < 10) a.push(d.title); doneBy.set(d.estate_id, a); }
    for (const n of nextRows) { const a = nextBy.get(n.estate_id) || []; if (a.length < 6) a.push(n); nextBy.set(n.estate_id, a); }
    for (const m of memRows) { const a = memBy.get(m.estate_id) || []; a.push(m.user_id); memBy.set(m.estate_id, a); }

    // 3) resolve member emails in one bulk profiles fetch
    const allUserIds = [...new Set(memRows.map(m => m.user_id))];
    const profRows = await inFetch("profiles", "id", allUserIds, "id,email");
    const emailById = new Map(profRows.map(p => [p.id, p.email]));

    // 4) build the send queue (only estates with activity + at least one email)
    const li = a => a.map(x => `<li style="margin:4px 0">${x}</li>`).join("");
    const jobs = [];
    for (const est of estates) {
      const done = doneBy.get(est.id) || [], next = nextBy.get(est.id) || [];
      if (!done.length && !next.length) continue;
      const emails = (memBy.get(est.id) || []).map(uid => emailById.get(uid)).filter(Boolean);
      if (!emails.length) continue;
      const html = `
      <div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:19px">HomegoingHQ · Weekly update</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
          <p style="font-size:15px">A quiet summary of where things stand for the estate of <strong>${est.decedent_name}</strong>.</p>
          ${done.length ? `<p style="font-weight:bold;margin:18px 0 6px">Completed this week</p><ul style="padding-left:20px;font-size:14px">${li(done)}</ul>` : ""}
          ${next.length ? `<p style="font-weight:bold;margin:18px 0 6px">Coming up</p><ul style="padding-left:20px;font-size:14px">${li(next.map(n => `${n.title}${n.due_at ? " — by " + n.due_at : ""}`))}</ul>` : ""}
          <p style="margin:24px 0 4px"><a href="${process.env.SITE_URL || ""}" style="background:#A67C2E;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold;font-size:13px">Open the roadmap</a></p>
          <p style="font-size:11px;color:#5B7183;margin-top:18px">You receive this because you're a member of this estate in HomegoingHQ.</p>
        </div>
      </div>`;
      jobs.push({ emails, subject: `Weekly update — estate of ${est.decedent_name}`, html });
      if (jobs.length >= MAX) break;
    }
    if (!jobs.length) return { statusCode: 200, body: "no digests to send" };

    // 5) send with bounded concurrency
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: j.emails.map(e => ({ to: [{ email: e }] })),
            from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
            subject: j.subject,
            content: [{ type: "text/html", value: j.html }]
          })
        }).catch(() => null);
        if (resp && resp.ok) sent++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

    return { statusCode: 200, body: `digests sent for ${sent} estates (of ${jobs.length} queued; ${estates.length} total)` };
  } catch (err) { return { statusCode: 200, body: "error " + err.message }; }
};
