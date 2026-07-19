// HomegoingHQ — LiveAvatar embed minter.
// Returns a ready-to-use LiveAvatar iframe URL so the API key stays server-side.
// Env: LIVEAVATAR_API_KEY  (get it at app.liveavatar.com/developers — this is a
//      SEPARATE platform/key from HEYGEN_API_KEY used for milestone renders).
//
// POST { avatarId, contextId, sandbox } -> { url }
//
// NOTE: the embed runs LiveAvatar FULL mode — HeyGen's model answers, steered by
// the "context" you configure in the LiveAvatar dashboard, with HeyGen's
// moderation. It does NOT run the ai-guide function's Survivor-Mode guardrails.
// Configure a compassionate, estate-appropriate context that defers legal/tax
// questions to a licensed professional. Keep sandbox=true (free) while testing.
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  if (!process.env.LIVEAVATAR_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "LIVEAVATAR_API_KEY not set (get it at app.liveavatar.com/developers)" }) };
  }
  try {
    const b = JSON.parse(event.body || "{}");
    const payload = {
      avatar_id: (b.avatarId || "").toString().trim(),
      context_id: (b.contextId || "").toString().trim(),
      is_sandbox: b.sandbox !== false
    };
    if (!payload.avatar_id || !payload.context_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "avatarId and contextId are required" }) };
    }
    const r = await fetch("https://api.liveavatar.com/v2/embeddings", {
      method: "POST",
      headers: { "X-API-KEY": process.env.LIVEAVATAR_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    const url = j && j.data && j.data.url;
    if (!url) return { statusCode: r.status || 502, headers, body: JSON.stringify({ error: (j && j.message) || "LiveAvatar did not return a URL", detail: j }) };
    return { statusCode: 200, headers, body: JSON.stringify({ url, sandbox: payload.is_sandbox }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
