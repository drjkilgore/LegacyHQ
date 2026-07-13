// HomegoingHQ — ElevenLabs text-to-speech proxy (keeps the API key server-side).
// Env vars (app.homegoinghq.com site):
//   ELEVENLABS_API_KEY   (required)
//   ELEVENLABS_VOICE_ID  (optional — defaults to "Rachel", a calm, warm voice)
//   ELEVENLABS_MODEL     (optional — defaults to eleven_turbo_v2_5)
// Returns audio/mpeg. If the key is missing or the call fails, the app falls back
// to the on-device browser voice, so nothing breaks before this is configured.

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: H, body: JSON.stringify({ error: "POST only" }) };

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { statusCode: 500, headers: H, body: JSON.stringify({ error: "not configured" }) };

  let text = "", voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  try {
    const b = JSON.parse(event.body || "{}");
    text = (b.text || "").toString().slice(0, 600);        // cap length (cost/safety)
    if (b.voice_id) voiceId = b.voice_id;
  } catch { /* ignore */ }
  if (!text) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "no text" }) };

  const model = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true }
      })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { statusCode: 502, headers: H, body: JSON.stringify({ error: "tts failed", status: r.status, detail: detail.slice(0, 200) }) };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
