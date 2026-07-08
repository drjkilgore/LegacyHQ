// Acceptance Sender — POST {key,name,email,path:"founding"|"cert"}
const LINKS={founding:"https://app.paythen.co/company/KinKeeper/plan/77soz8xs7y",
             cert:"https://app.paythen.co/company/KinKeeper/plan/r6ditgu3a8", welcome:"x",
             plan:"https://app.paythen.co/company/KinKeeper/plan/3yubg905jl"};
exports.handler=async(event)=>{
  if(event.httpMethod!=="POST")return{statusCode:405,body:"POST only"};
  const {key,name,email,path}=JSON.parse(event.body||"{}");
  if(!key||key!==process.env.ACCEPT_KEY)return{statusCode:401,body:JSON.stringify({error:"Bad key"})};
  if(!name||!email||!LINKS[path])return{statusCode:400,body:JSON.stringify({error:"name, email, path required"})};
  const founding=path==="founding";
  if(path==="welcome"){
    const html=`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26332E">
    <div style="background:#26332E;color:#F6F2EA;border-radius:14px;padding:26px;text-align:center"><div style="font-size:20px;font-weight:700">Homegoing<span style="color:#C9A24B">HQ</span> Academy™</div></div>
    <div style="padding:26px 6px"><p>Dear ${name},</p>
    <p><b>You are enrolled.</b> Your payment is received and your seat in HomegoingHQ Academy is open.</p>
    <p><b>Getting started:</b></p>
    <p>1. Go to <a href="https://academy.homegoinghq.com">academy.homegoinghq.com</a> and create your account — <b>use the exact name you want printed on your certificate.</b><br>
    2. Open <b>HC-101: The Concierge Calling</b> — your first course is waiting.<br>
    3. Work at your pace; every module ends with an assessment (80% to pass), and your credential prints the day you finish.</p>
    <p>Reply to this email any time — a person reads it.</p>
    <p>Welcome to the work.</p>
    <p>Jessie E. Kilgore, Jr., Ph.D.<br><span style="color:#68756D;font-size:13px">Founder &amp; Director of Certification &mdash; HomegoingHQ</span></p></div></div>`;
    const rw=await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",
      headers:{Authorization:`Bearer ${process.env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({personalizations:[{to:[{email,name}]}],
        from:{email:process.env.FROM_EMAIL||"care@homegoinghq.com",name:"HomegoingHQ Academy"},
        reply_to:{email:"care@homegoinghq.com"},
        subject:"You are enrolled — HomegoingHQ Academy™",
        content:[{type:"text/html",value:html}]})});
    if(rw.status>=300){const t=await rw.text();return{statusCode:502,body:JSON.stringify({error:"SendGrid: "+t.slice(0,200)})}}
    return{statusCode:200,body:JSON.stringify({ok:true})};
  }
  const pay=LINKS[path], code="FOUNDING2026";
  const html=`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26332E">
  <div style="background:#26332E;color:#F6F2EA;border-radius:14px;padding:26px;text-align:center">
    <div style="font-size:20px;font-weight:700">Homegoing<span style="color:#C9A24B">HQ</span> ${founding?"Concierge™":"Academy™"}</div>
  </div>
  <div style="padding:26px 6px">
  <p>Dear ${name},</p>
  <p><b>Congratulations — you have been accepted${founding?" to the Founding 100":" to HomegoingHQ Academy"}.</b></p>
  <p>We read every application personally, and yours told us you are exactly the kind of person families need walking beside them.</p>
  <p><b>Your next step:</b> ${founding
    ?`activate your founding seat ($99/month, locked for life — Academy certification included):`
    :`complete your tuition (early-cohort rate $995, or 3 payments of $525 — see both options on the Tuition page):`}</p>
  <p style="text-align:center"><a href="${pay}" style="background:#8F6A24;color:#fff;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700">${founding?"Activate your founding seat":"Pay tuition"}</a></p>
  <p>Your acceptance code is <b>${code}</b> — the Tuition &amp; payments page at concierge.homegoinghq.com will ask for it.</p>
  <p><b>Then:</b> within one business day of payment, you'll receive your HomegoingHQ Academy enrollment at academy.homegoinghq.com — create your account with the exact name you want on your certificate.</p>
  <p>Welcome. We are honored to walk with you.</p>
  <p>Jessie E. Kilgore, Jr., Ph.D.<br><span style="color:#68756D;font-size:13px">Founder &amp; Director of Certification &mdash; HomegoingHQ</span></p>
  </div>
  <p style="font-size:11px;color:#8a8f8b;text-align:center">HomegoingHQ · care@homegoinghq.com · Certification is required before serving families under the credential.</p></div>`;
  const r=await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",
    headers:{Authorization:`Bearer ${process.env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({personalizations:[{to:[{email,name}]}],
      from:{email:process.env.FROM_EMAIL||"care@homegoinghq.com",name:"HomegoingHQ"},
      reply_to:{email:"care@homegoinghq.com"},
      subject:founding?"Welcome to the Founding 100 — HomegoingHQ Concierge™":"Your acceptance — HomegoingHQ Academy™",
      content:[{type:"text/html",value:html}]})});
  if(r.status>=300){const t=await r.text();return{statusCode:502,body:JSON.stringify({error:"SendGrid: "+t.slice(0,200)})}}
  return{statusCode:200,body:JSON.stringify({ok:true})};
};

