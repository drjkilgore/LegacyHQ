// HomegoingHQ — Plaid: one-time account discovery (balances) and a one-time
// recurring-charge sweep (transactions). The access token is ALWAYS discarded
// immediately after the read — no bank connection is stored.
// Env vars: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production)
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const host = "https://" + (process.env.PLAID_ENV || "sandbox") + ".plaid.com";
  const creds = { client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
  if (!creds.client_id || !creds.secret)
    return { statusCode: 200, headers, body: JSON.stringify({ error: "Plaid isn't configured yet." }) };
  const call = async (path, body) => {
    const r = await fetch(host + path, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, ...body }) });
    return r.json();
  };
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  // Detect recurring OUTFLOWS from a list of Plaid transactions.
  function detectRecurring(transactions) {
    const out = (transactions || []).filter(t => Number(t.amount) > 0 && !t.pending);
    const norm = s => String(s || "").toLowerCase().replace(/[0-9]{2,}/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    const groups = {};
    out.forEach(t => { const k = norm(t.merchant_name || t.name); if (k) (groups[k] = groups[k] || []).push(t); });
    const streams = [];
    Object.values(groups).forEach(txns => {
      if (txns.length < 2) return;
      const amounts = txns.map(t => Number(t.amount)).sort((a, b) => a - b);
      const med = amounts[Math.floor(amounts.length / 2)];
      const consistent = amounts.filter(a => Math.abs(a - med) <= Math.max(1, med * 0.25)).length;
      if (consistent < 2) return;
      const dates = txns.map(t => t.date).sort();
      let gaps = []; for (let i = 1; i < dates.length; i++) gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
      const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 30;
      let cadence = "recurring", monthly = med;
      if (avgGap <= 10) { cadence = "weekly"; monthly = med * 4.33; }
      else if (avgGap <= 45) { cadence = "monthly"; monthly = med; }
      else if (avgGap <= 100) { cadence = "every few months"; monthly = med / (avgGap / 30); }
      else { cadence = "yearly"; monthly = med / 12; }
      streams.push({
        name: txns[0].merchant_name || txns[0].name || "Recurring charge",
        amount: Math.round(med * 100) / 100, cadence, count: txns.length,
        last_date: dates[dates.length - 1], monthly: Math.round(monthly * 100) / 100
      });
    });
    streams.sort((a, b) => b.monthly - a.monthly);
    return { streams: streams.slice(0, 40), monthly_total: Math.round(streams.reduce((s, x) => s + x.monthly, 0) * 100) / 100 };
  }

  try {
    const { action, userId, public_token, products, accessToken } = JSON.parse(event.body || "{}");
    // Require a signed-in user so Plaid link/exchange can't be abused anonymously (cost/quota).
    const SB_URL = process.env.SUPABASE_URL, SB_ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaHFnbW51cm5rZ2J3cHZyYWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjc0NTYsImV4cCI6MjA5ODk0MzQ1Nn0.fXDBbljOS_p49FS9vU4smAWxyn4STYuLRGFf9rJgp-Q";
    if (SB_URL) {
      if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };
      const who = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + accessToken } });
      if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    }

    if (action === "link_token") {
      const d = await call("/link/token/create", {
        client_name: "HomegoingHQ",
        user: { client_user_id: userId || "anon" },
        products: Array.isArray(products) && products.length ? products : ["transactions"],
        country_codes: ["US"], language: "en"
      });
      if (d.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: d.error_message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ link_token: d.link_token }) };
    }

    if (action === "discover") {
      const ex = await call("/item/public_token/exchange", { public_token });
      if (ex.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: ex.error_message }) };
      const bal = await call("/accounts/balance/get", { access_token: ex.access_token });
      await call("/item/remove", { access_token: ex.access_token });
      if (bal.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: bal.error_message }) };
      const accounts = (bal.accounts || []).map(a => ({
        name: (a.name || a.official_name || "Account") + (a.mask ? " ••••" + a.mask : ""),
        type: a.subtype || a.type,
        balance: a.balances?.current ?? a.balances?.available ?? 0
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ accounts, institution: bal.item?.institution_id || "" }) };
    }

    if (action === "recurring") {
      const ex = await call("/item/public_token/exchange", { public_token });
      if (ex.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: ex.error_message }) };
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      let txns = null, ready = false, errMsg = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await call("/transactions/get", { access_token: ex.access_token, start_date: start, end_date: end, options: { count: 500, offset: 0 } });
        if (r.error_code === "PRODUCT_NOT_READY") { await sleep(2500); continue; }
        if (r.error_message) { errMsg = r.error_message; break; }
        txns = r.transactions || []; ready = true; break;
      }
      await call("/item/remove", { access_token: ex.access_token }); // discard the connection
      if (errMsg) return { statusCode: 502, headers, body: JSON.stringify({ error: errMsg }) };
      if (!ready) return { statusCode: 200, headers, body: JSON.stringify({ status: "gathering" }) };
      return { statusCode: 200, headers, body: JSON.stringify(Object.assign({ ok: true }, detectRecurring(txns))) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown action" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
