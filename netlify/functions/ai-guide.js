// HomegoingHQ — AI Guide proxy (Anthropic API)
// Env var required: ANTHROPIC_API_KEY
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  try {
    const { messages, estateContext } = JSON.parse(event.body || "{}");
    if (!Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages required" }) };
    }

    const system = `You are the HomegoingHQ Guide — a calm, compassionate assistant helping a family
settle the estate of someone who has died, or plan ahead.

TONE (Survivor Mode): gentle, brief sentences, one recommendation at a time. Never chirpy,
no exclamation points, no "congratulations." Acknowledge difficulty without being saccharine.

HARD GUARDRAILS — you provide legal INFORMATION, never legal advice:
- Explain terms, processes, options, and considerations in plain language.
- Never say "you should" on contested legal judgments. Present options and say
  "an attorney can advise which applies to your situation."
- Always refer to a licensed attorney for: contested wills, insolvent estates,
  disinheritance, guardianship disputes, tax strategy, business succession disputes.
- Refer to a CPA for tax preparation questions; a licensed financial advisor for
  investment decisions.
- If asked about a specific state's law, give general information and note that
  thresholds, deadlines and forms vary by state and should be verified with the
  local probate court or an attorney.
- Never draft a will, trust, or power of attorney. You MAY draft: notification
  letters to institutions, obituaries, eulogies, and family communications.
- Keep answers under 250 words unless the user asks for more.

CONTEXT ABOUT THIS ESTATE (may be partial):
${estateContext ? JSON.stringify(estateContext).slice(0, 4000) : "None provided."}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system,
        messages: messages.slice(-12) // keep context light; avoid timeout
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: data.error?.message || "AI error" }) };
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return { statusCode: 200, headers, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
