// HomegoingHQ — Invite email via SendGrid
// Env vars: SENDGRID_API_KEY, FROM_EMAIL (verified sender), SITE_URL
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (!process.env.SENDGRID_API_KEY) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };

  try {
    const { email, inviterName, contextName, kind, unlockAt } = JSON.parse(event.body || "{}");
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };

    const site = process.env.SITE_URL || "";
    let subject, intro, cta = "Open HomegoingHQ";
    if (kind === "concierge") {
      const t = JSON.parse(event.body || "{}");
      const vwEmail = process.env.TALENT_EMAIL || "Info@VWEntertainment.com";
      const row = (l, v) => v ? `<tr><td style="padding:4px 10px 4px 0;color:#5B7183;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top">${l}</td><td style="padding:4px 0;font-size:14px">${String(v).replace(/</g,"&lt;")}</td></tr>` : "";
      const vwHtml = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:18px">Concierge request — via ${t.brandName || "HomegoingHQ"}</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
        <p style="font-size:14px">A family has asked for personal, hands-on support:</p>
        <table style="margin-top:10px">${row("Support level", t.needLabel)}${row("Urgency", t.urgency)}
        ${row("Situation", t.details)}${row("Family contact", t.contactName)}${row("Phone", t.contactPhone)}${row("Email", t.contactEmail)}${row("Best time to call", t.bestTime)}</table>
        <p style="font-size:12px;color:#5B7183;margin-top:16px">Referred by ${t.brandName || "HomegoingHQ"} (EdConsult LLC). Reference: ${t.reference || ""}. Reminder: concierge support is organizational and logistical — legal, tax, and financial advice stay with licensed professionals.</p></div></div>`;
      const famHtml = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:18px">A person will walk with you</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
        <p style="font-size:15px;line-height:1.6">Your request has gone to our concierge partner. A dedicated coordinator will call you — usually within one business day — to listen, understand where things stand, and set up the support that fits, from a few unsticking calls to walking the whole road beside you.</p>
        <p style="font-size:13px;color:#5B7183">They'll quote everything clearly before anything begins. Concierge support is organizational and logistical; where the law, taxes, or money need a licensed professional, they'll help you get to the right one.</p>
        </div></div>`;
      const sends = [
        { to: vwEmail, subject: `Concierge request: ${t.needLabel} — ${t.urgency || ""} (${t.brandName || "HomegoingHQ"})`, html: vwHtml },
        t.contactEmail ? { to: t.contactEmail, subject: "Your concierge request — a coordinator will call", html: famHtml } : null
      ].filter(Boolean);
      for (const m of sends) {
        await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }],
            from: { email: process.env.FROM_EMAIL, name: t.brandName || "HomegoingHQ" },
            subject: m.subject, content: [{ type: "text/html", value: m.html }] })
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ sent: true }) };
    }

    if (kind === "talent") {
      const t = JSON.parse(event.body || "{}");
      const vwEmail = process.env.TALENT_EMAIL || "Info@VWEntertainment.com";
      const site = process.env.SITE_URL || "";
      const row = (l, v) => v ? `<tr><td style="padding:4px 10px 4px 0;color:#5B7183;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top">${l}</td><td style="padding:4px 0;font-size:14px">${String(v).replace(/</g,"&lt;")}</td></tr>` : "";
      const vwHtml = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:18px">New booking inquiry — via ${t.brandName || "HomegoingHQ"}</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
        <p style="font-size:14px">A family planning a service has requested music/talent support:</p>
        <table style="margin-top:10px">${row("Need", t.needLabel)}${row("Service date", t.serviceDate)}${row("Location", t.location)}
        ${row("Budget range", t.budget)}${row("Artist wishes", t.artistWishes)}${row("Details", t.details)}
        ${row("Family contact", t.contactName)}${row("Phone", t.contactPhone)}${row("Email", t.contactEmail)}</table>
        <p style="font-size:12px;color:#5B7183;margin-top:16px">Referred by ${t.brandName || "HomegoingHQ"} (EdConsult LLC). Reference: ${t.reference || ""}</p></div></div>`;
      const famHtml = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:20px 26px;font-size:18px">Your music & tribute request is in caring hands</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:24px;background:#FFFDF9">
        <p style="font-size:15px;line-height:1.6">We've sent your request to our booking partner, <strong>VisionWorks Entertainment</strong> — 25 years of direct relationships with gospel, jazz, and R&B artists, trusted by churches nationwide. Pam and her team will reach out to you directly, usually within one business day.</p>
        <p style="font-size:14px">Need them sooner? Call <strong>(469) 274-2820</strong> or <strong>(913) 285-5554</strong> and mention ${t.brandName || "HomegoingHQ"}.</p>
        </div></div>`;
      const sends = [
        { to: vwEmail, subject: `Booking inquiry: ${t.needLabel} — ${t.serviceDate || "date TBD"} (${t.brandName || "HomegoingHQ"})`, html: vwHtml },
        t.contactEmail ? { to: t.contactEmail, subject: "Your music & tribute request — received", html: famHtml } : null
      ].filter(Boolean);
      for (const m of sends) {
        await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }],
            from: { email: process.env.FROM_EMAIL, name: t.brandName || "HomegoingHQ" },
            subject: m.subject, content: [{ type: "text/html", value: m.html }] })
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ sent: true }) };
    }

    if (kind === "witness") {
      const w = JSON.parse(event.body || "{}");
      subject = `Recording certificate — last wishes of ${w.declaredName}`;
      intro = `A last-wishes video was recorded and sealed for <strong>${w.declaredName}</strong> on ${new Date(w.recordedAt).toLocaleString()}.<br><br>
        Its digital fingerprint (SHA-256) is:<br>
        <span style="font-family:monospace;font-size:12px;word-break:break-all;background:#F6F2EA;padding:8px 10px;border-radius:8px;display:inline-block;margin-top:6px">${w.sha256}</span><br><br>
        Keep this email. If anyone ever questions whether the recording was altered, this fingerprint — held independently in your mailbox with this timestamp — will match the video if and only if it is unchanged, byte for byte. The recording can be re-verified anytime inside the app.`;
      cta = "View in the app";
    } else if (kind === "emergency") {
      subject = `Emergency access requested on your HomegoingHQ plan`;
      intro = `${inviterName} has requested emergency access to your plan for ${contextName}, attesting that access is needed now. If this is expected, no action is needed — access unlocks automatically ${unlockAt ? "on " + new Date(unlockAt).toLocaleString() : "after your waiting period"}. <strong>If this is NOT expected, sign in immediately and decline the request.</strong>`;
      cta = "Review the request";
    } else if (kind === "estate") {
      subject = `${inviterName} invited you to help settle the estate of ${contextName}`;
      intro = `${inviterName} is using HomegoingHQ to coordinate everything after the passing of ${contextName}, and has invited you to help — tasks, documents, and next steps, all in one calm place.`;
    } else {
      subject = `${inviterName} shared their HomegoingHQ plan with you`;
      intro = `${inviterName} has organized important information for ${contextName} in HomegoingHQ and wants you to have access when it matters.`;
    }

    const html = `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">HomegoingHQ</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
          <p style="font-size:16px;line-height:1.6">${intro}</p>
          ${kind==="emergency" ? "" : `<p style="font-size:15px;line-height:1.6">To join, create a free account using <strong>this email address</strong> — you'll be connected automatically:</p>`}
          <p style="margin:26px 0"><a href="${site}" style="background:#A67C2E;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">${cta}</a></p>
          <p style="font-size:12px;color:#5B7183">If you weren't expecting this, you can safely ignore this email.</p>
        </div>
      </div>`;

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
        subject,
        content: [{ type: "text/html", value: html }]
      })
    });
    return { statusCode: 200, headers, body: JSON.stringify({ sent: resp.ok }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
