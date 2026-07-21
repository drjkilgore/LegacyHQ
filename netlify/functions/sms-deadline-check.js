// HomegoingHQ — daily scheduled SMS deadline reminders (scale-optimized).
// Bulk-fetches subscriptions/members/prior-sends in a few queries (no per-task N+1),
// paginates the due-task read, sends with bounded concurrency, caps sends per run,
// and resumes safely next run via sms_sent_log dedupe.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//      TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER, optional SMS_MAX_PER_RUN.
exports.handler = async () => {
  const SB = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const MSID = process.env.TWILIO_MESSAGING_SERVICE_SID, FROM = process.env.TWILIO_FROM_NUMBER;
  if (!SB || !SR) return { statusCode: 200, body: "supabase not configured" };
  if (!SID || !TOKEN || (!MSID && !FROM)) return { statusCode: 200, body: "twilio not configured" };
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };
  const q = async (path) => (await fetch(SB + "/rest/v1/" + path, { headers: SRH })).json();
  const MAX_SENDS = Number(process.env.SMS_MAX_PER_RUN || 400);   // keep within function timeout + carrier rate
  const CONCURRENCY = 8;

  // chunked IN-fetch to avoid oversized URLs and to bulk-read
  const inFetch = async (table, col, ids, select, extra = "") => {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await q(`${table}?select=${select}&${col}=in.(${chunk.join(",")})${extra}`);
      if (Array.isArray(r)) out.push(...r);
    }
    return out;
  };
  const sendSms = async (to, body) => {
    const p = new URLSearchParams(); p.set("To", to); p.set("Body", body);
    if (MSID) p.set("MessagingServiceSid", MSID); else p.set("From", FROM);
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages.json", {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(SID + ":" + TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: p.toString()
    });
    return r.ok;
  };

  const now = new Date(), soon = new Date(now.getTime() + 3 * 86400000);
  let sent = 0;
  try {
    // 1) due tasks — paginated so nothing is silently dropped
    const tasks = []; let offset = 0;
    while (true) {
      const page = await q(`tasks?select=id,estate_id,title,due_at,assignee&status=eq.todo&due_at=gte.${now.toISOString()}&due_at=lte.${soon.toISOString()}&order=due_at&limit=1000&offset=${offset}`);
      if (!Array.isArray(page) || !page.length) break;
      tasks.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
    }
    if (!tasks.length) return { statusCode: 200, body: "no due tasks" };

    const estateIds = [...new Set(tasks.map(t => t.estate_id))];
    const taskIds = tasks.map(t => t.id);

    // 2) bulk-fetch everything we need (a few queries total, not per-task)
    const subsRows = await inFetch("sms_subscriptions", "estate_id", estateIds, "estate_id,user_id,phone", "&consent=eq.true&opted_out=eq.false");
    const memRows  = await inFetch("estate_members", "estate_id", estateIds, "estate_id,user_id");
    const sentRows = await inFetch("sms_sent_log", "task_id", taskIds, "task_id,user_id");

    // 3) index in memory
    const subsByEstate = new Map();  // estate_id -> Map(user_id -> phone)
    for (const s of subsRows) { if (!subsByEstate.has(s.estate_id)) subsByEstate.set(s.estate_id, new Map()); subsByEstate.get(s.estate_id).set(s.user_id, s.phone); }
    const membersByEstate = new Map();
    for (const m of memRows) { if (!membersByEstate.has(m.estate_id)) membersByEstate.set(m.estate_id, []); membersByEstate.get(m.estate_id).push(m.user_id); }
    const alreadySent = new Set(sentRows.map(r => r.task_id + "|" + r.user_id));

    // 4) build the send queue (assignee, else all members; opted-in only; not already sent)
    const jobs = [];
    for (const t of tasks) {
      const subMap = subsByEstate.get(t.estate_id); if (!subMap || !subMap.size) continue;
      const recipients = t.assignee ? [t.assignee] : (membersByEstate.get(t.estate_id) || []);
      for (const uid of recipients) {
        const phone = subMap.get(uid); if (!phone) continue;
        const key = t.id + "|" + uid; if (alreadySent.has(key)) continue;
        alreadySent.add(key);
        const due = t.due_at ? (" (due " + String(t.due_at).slice(0, 10) + ")") : "";
        jobs.push({ task_id: t.id, user_id: uid, phone, body: `HomegoingHQ reminder: "${t.title}"${due}. Reply STOP to opt out.` });
        if (jobs.length >= MAX_SENDS) break;
      }
      if (jobs.length >= MAX_SENDS) break;
    }
    if (!jobs.length) return { statusCode: 200, body: "nothing new to send" };

    // 5) send with bounded concurrency
    const logged = []; let idx = 0;
    const worker = async () => { while (idx < jobs.length) { const j = jobs[idx++]; const ok = await sendSms(j.phone, j.body); if (ok) { sent++; logged.push({ task_id: j.task_id, user_id: j.user_id }); } } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

    // 6) bulk-insert dedupe log (chunked)
    for (let i = 0; i < logged.length; i += 200) {
      await fetch(SB + "/rest/v1/sms_sent_log", { method: "POST", headers: Object.assign({}, SRH, { Prefer: "return=minimal" }), body: JSON.stringify(logged.slice(i, i + 200)) }).catch(() => {});
    }
    return { statusCode: 200, body: `sent ${sent} (queued ${jobs.length}; ${tasks.length} due tasks, ${estateIds.length} estates)` };
  } catch (err) { return { statusCode: 200, body: "error " + err.message }; }
};
