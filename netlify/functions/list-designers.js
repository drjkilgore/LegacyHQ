// HomegoingHQ — list approved designers' PUBLIC profiles for family browsing.
// Never returns ID, W-9, email, or phone — only what's safe to show families.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !KEY) return { statusCode: 200, headers, body: JSON.stringify({ designers: [] }) };
  try {
    const { state } = JSON.parse(event.body || "{}");
    const st = (state || "").toUpperCase().trim();
    const cols = "id,full_name,bio,specialties,states,languages,turnaround_days,profile_photo,portfolio_urls,availability,rating,completed_count,featured";
    let url = SB + "/rest/v1/designers?status=eq.approved&availability=in.(available,busy)"
      + "&order=featured.desc,rating.desc.nullslast,completed_count.desc&select=" + cols;
    if (st) url += "&states=cs.{" + encodeURIComponent(st) + "}";
    const r = await fetch(url, { headers: { "apikey": KEY, "Authorization": "Bearer " + KEY } });
    const rows = await r.json();
    return { statusCode: 200, headers, body: JSON.stringify({ designers: Array.isArray(rows) ? rows : [] }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, designers: [] }) };
  }
};
