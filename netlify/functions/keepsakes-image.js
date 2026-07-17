// ============================================================================
// Netlify Function: keepsakes-image
// Accepts a base64 image from the browser and stores it in a PUBLIC Supabase
// Storage bucket, returning a public URL that Prodigi can download at print
// time. Upload is done with the service-role key server-side, so the browser
// never gets write access to your bucket.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   KEEPSAKES_BUCKET   optional, defaults to "keepsakes"
//
// Prereq (one-time): create a PUBLIC bucket named "keepsakes" in Supabase
// Storage. Public is required so Prodigi's servers can fetch the asset.
//
// Request (POST JSON): { dataUrl | base64, filename?, contentType? }
// Response: { url }
// ============================================================================

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.KEEPSAKES_BUCKET || "keepsakes";
  if (!SB || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase env not set" }) };

  try {
    const b = JSON.parse(event.body || "{}");
    let raw = b.base64 || b.dataUrl || "";
    let contentType = b.contentType || "";
    const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
    if (m) { contentType = contentType || m[1]; raw = m[2]; }
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "no image data" }) };
    contentType = contentType || "image/jpeg";

    const allowed = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "application/pdf": "pdf" };
    const ext = allowed[contentType];
    if (!ext) return { statusCode: 400, headers, body: JSON.stringify({ error: "unsupported type (jpg, png, pdf only)" }) };

    const buf = Buffer.from(raw, "base64");
    if (buf.length > 25 * 1024 * 1024) return { statusCode: 413, headers, body: JSON.stringify({ error: "file too large (25MB max)" }) };

    const safe = String(b.filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
    const path = `orders/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}.${ext}`;

    const up = await fetch(`${SB}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + KEY,
        "apikey": KEY,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: buf,
    });
    if (!up.ok) {
      const t = await up.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: "upload failed", detail: t.slice(0, 300) }) };
    }

    const url = `${SB}/storage/v1/object/public/${bucket}/${path}`;
    return { statusCode: 200, headers, body: JSON.stringify({ url }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
