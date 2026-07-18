# HomegoingHQ — Setup Guide (browser-only, no CLI)

MVP 1: Survivor Mode SaaS — multi-tenant, roadmap engine, family collaboration,
document vault, notification tracker + templates, AI Guide, Stripe upgrade path.

## What's in this folder
```
index.html                          The entire app (SPA)
netlify.toml                        Netlify config (functions dir)
netlify/functions/ai-guide.js       Anthropic proxy for the AI Guide
netlify/functions/stripe-checkout.js  Creates Stripe Checkout sessions
netlify/functions/stripe-webhook.js   Upgrades a user's tier after payment
supabase-schema.sql                 Full database schema + RLS
```

## Step 1 — Supabase (≈10 minutes)
1. supabase.com → **New project** → name it `legacyhq` (dedicated project — do not reuse Kilgore Apps or wealthhq).
2. **SQL Editor → New query** → paste ALL of `supabase-schema.sql` **except the three storage policies near the bottom** → Run.
3. **Storage → New bucket** → name `estate-docs` → **Private** → Save.
4. Back in SQL Editor, run just the three `storage.objects` policy statements.
5. **Authentication → Sessions → JWT expiry = 3600** (the known outage fix — do it now).
6. **Authentication → Providers → Email**: for fastest testing, turn OFF "Confirm email." Turn it back on before selling.
7. **Project Settings → API**: copy the **Project URL** and **anon public key**.

## Step 2 — Configure the app (2 minutes)
Open `index.html`, find the CONFIG block near the top of the first `<script>`:
```js
const SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
```
Paste your two values. (The anon key is safe to ship in the frontend — RLS is the security layer.)

## Step 3 — Netlify (5 minutes)
1. Drag this **entire folder** into Netlify (app.netlify.com → Add new site → Deploy manually). The `netlify.toml` + `netlify/functions` folder deploy the functions automatically.
2. **Site configuration → Environment variables**, add:
   - `ANTHROPIC_API_KEY` — your Anthropic key (powers the AI Guide)
   - `SITE_URL` — your Netlify URL, e.g. `https://legacyhq.netlify.app`
3. Redeploy (drag the folder again) so env vars take effect.
4. Supabase → **Authentication → URL Configuration** → set Site URL to your Netlify URL.

**Test:** open the site → create an account → "Someone close to me has died" → answer the intake → roadmap appears. Invite a second email; sign up in a private window with that email; it auto-joins the estate.

## Step 4 — Stripe (optional now, required to sell)
1. Stripe → **Products**: create "HomegoingHQ Settle" — one-time, e.g. $249. Copy the **price ID** (`price_…`).
2. Netlify env vars: add `STRIPE_SECRET_KEY` and `STRIPE_PRICE_SETTLE` (and `STRIPE_PRICE_PREMIUM` later).
3. Stripe → **Developers → Webhooks → Add endpoint**:
   `https://YOUR-SITE.netlify.app/.netlify/functions/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`.
4. Netlify env vars: add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API → service_role — **server-side only, never in index.html**).
5. Redeploy. Test with Stripe test mode card `4242 4242 4242 4242` — after checkout the user's tier flips to `settle` and gates lift.

⚠️ Before charging real customers: add Stripe webhook **signature verification** (`STRIPE_WEBHOOK_SECRET`) to `stripe-webhook.js` — v1 omits it to stay dependency-free.

### Vault Keeper — tiered vault, read-only at cap, 45-day grace ($8/mo)
**Every** family is metered; the included allowance scales with the plan —
**free 5 documents, Companion 10, Settle 20** (each with a matching storage cap,
whichever is reached first). At the cap, existing documents stay **open to view
and download** — only new uploads are blocked until an active
Vault Keeper subscription ($8/mo) lifts it. A settlement purchase
(Companion/Settle/Premium) unlocks the rest of the app but **not** the vault. A
one-time explainer pops on the first upload. When a subscriber **cancels or a
payment fails**, a **45-day grace window** opens: they keep read/download access
and see a banner telling them to download (cancel) or update payment (failure); if
unresolved, `vault-sweep.js` deletes the documents.
1. Run `supabase-migration-v23-vault-subscription.sql` (adds `vault_status`,
   `vault_subscription_id`, `vault_current_period_end`, `vault_grace_until` to
   `profiles`; `size_bytes` to `documents`).
2. Stripe → **Products**: create "HomegoingHQ Vault Keeper" — **recurring, $8/month**.
   Copy the price ID → Netlify env var `STRIPE_PRICE_VAULT`.
3. Add the five webhook events above. The webhook sets `vault_status` = `active`
   on checkout/recovery, `past_due` on failed payment, `canceled` on cancellation,
   and stamps a 45-day `vault_grace_until` on the first lapse (matched by
   `vault_subscription_id`, so a concierge subscription is never affected).
4. **Deletion** is handled by `vault-sweep.js`, a daily Netlify Scheduled Function
   (already wired in `netlify.toml`). It removes the vault documents of lapsed
   subscribers past their grace deadline and resets them to `inactive`. No extra
   setup — it uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
5. Stripe → **Settings → Billing → Customer portal**: enable it so "Update payment
   method" / "Manage subscription" (`stripe-portal.js`) works.
6. Tune in `index.html`: `VAULT_ALLOWANCE` (per-plan document + storage caps),
   `VAULT_PRICE`,
   `VAULT_GRACE_DAYS` (keep `VAULT_GRACE_DAYS` in step with the 45-day value in
   `stripe-webhook.js` and `vault-sweep.js` if you change it).

## Free vs. Settle gating (built in)
| | Free | Settle |
|---|---|---|
| Estates | 1 | Unlimited |
| People per estate | 2 | Unlimited |
| Letter templates | 2 | All |
| Roadmap, docs, AI Guide | ✓ | ✓ |

Adjust gates in `index.html`: search for `plan_tier==="free"` (three places).

## Before real sales — short checklist
1. Stripe webhook signature verification (above).
2. Turn email confirmation back on in Supabase Auth.
3. Custom domain + Netlify HTTPS.
4. Terms of Service + Privacy Policy pages (attorney-reviewed; the UPL disclaimer language matters in this category).
5. Trademark search on the HomegoingHQ name.
6. Consider Supabase daily backups (Settings → Database → Backups) — this data is irreplaceable to customers.

## Release 2 — Planner Mode (included in this package)
Adds the recurring-revenue side: the 13-section vault, Readiness Score, Executor
Packet, plan sharing, and SendGrid invite emails.

**To activate:**
1. Supabase → SQL Editor → run ALL of `supabase-migration-v2.sql` (additive — safe on your live database).
2. Netlify env vars → add `SENDGRID_API_KEY` and `FROM_EMAIL` (a verified SendGrid sender). Without these, invites still work silently in-app — the email is simply skipped.
3. Redeploy the folder.

**What it does:** "I'm planning ahead" on the home screen creates a life plan
(self, spouse, or a parent). The vault has 13 sections with suggested-entry chips,
a masked "number" field for sensitive values, and a "where the original lives"
field on every entry. The Readiness Score (0–100) weights sections by how much
grief they prevent, and always shows the next three best steps. The **Executor
Packet** button generates a print-ready index of everything — with sensitive
numbers masked to last-4 or included, your choice — for the fireproof box.

Free-tier gates: 1 life plan, 12 vault entries. Search `plan_tier==="free"` to adjust.

## Release 3 — Ledger, Probate, Emergency Access (included in this package)

**To activate:** Supabase → SQL Editor → run ALL of `supabase-migration-v3.sql`
(additive — safe on your live database), then redeploy the folder.

**Estate Ledger** (new Ledger tab on every estate): Assets with date-of-death
values and titling, Debts & creditor claims with status, Expenses with
reimbursable tracking, Beneficiaries, and Distributions with receipt tracking.
The Overview shows estate value, projected net estate, and remaining-to-settle —
plus two **court-ready exports**: Inventory of Assets and a full Estate
Accounting with signature blocks (print → save as PDF). Exports are gated to
the Settle tier — this is the feature executors pay for.

**Probate Assistant** (new Probate tab): a 3-question path quiz that recommends
No-probate / Small-estate / Informal / Formal, with a one-tap "Add these steps
to my roadmap." Includes a **Michigan state pack** (personal-representative
terminology, unsupervised probate flow, 4-month creditor window, 5-month
minimum, SCAO form references PC 556/558/572/577/591, small-estate guidance)
and a generic pack for every other state. ⚠️ The MI pack carries a
"reviewed July 2026" stamp and tells users to verify current thresholds and
form versions — have a Michigan probate attorney review this content before
marketing it as state-specific guidance.

**Emergency access** (Emergency access button on every plan): the owner
designates trusted contacts with a waiting period (48h–14 days) and a role.
The designee uses "I was named as someone's emergency contact" on the home
screen; the owner is emailed immediately (SendGrid) and can decline in-app;
if the window passes unvetoed, the designee claims access and the plan appears
in their workspace. All enforced server-side via security-definer functions.

## Release 4 — Funeral Center, Memories, Memorial Pages, Weekly Digest (included)

**To activate:**
1. Supabase → SQL Editor → run `supabase-migration-v4.sql` **except the two storage
   policies at the bottom**.
2. Storage → New bucket → name `memorial-media` → **Public** → then run the two
   storage policy statements.
3. Redeploy the folder. The weekly digest is scheduled automatically by
   `netlify.toml` (Mondays 14:00 UTC) — it silently skips if SendGrid or the
   service-role env vars aren't set. Required env vars for the digest:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENDGRID_API_KEY`, `FROM_EMAIL`, `SITE_URL`.

**Funeral Planning Center** (new Funeral tab): budget with 15 standard line items
one tap away, planned-vs-actual with over/under indicator, FTC Funeral Rule
coaching, provider comparison cards (mark one "chosen"), and an **AI Obituary
Builder** — guided inputs → tone selection → editable draft → copy or print.
Drafts omit exact birth dates and street addresses by design (identity-theft
protection for the deceased).

**Memories & Memorial Pages** (new Memories tab): stories, tributes, letters,
recipes, and photos. Each memory has a Publish toggle; published items appear on
a **public memorial page** at `yoursite.netlify.app/?memorial=TOKEN` — headline,
service details, in-lieu-of-flowers note, tributes, and photos. No sign-in needed
to view; the family controls the link and can take the page offline anytime.
Photos live in the public `memorial-media` bucket — the UI warns that uploads
there are shareable by design. Private documents stay in the private bucket.

**Weekly family digest**: every Monday, each estate's members receive a quiet
summary — completed this week, coming up in the next 14 days — with a link back
to the roadmap. Estates with no activity are skipped.

## Release 5 — Insurance Claims, Government Checklist, PWA (included)

**To activate:**
1. Supabase → SQL Editor → run `supabase-migration-v5.sql` (as admin / "Run without RLS").
2. Redeploy the folder — it now also contains `manifest.webmanifest`, `sw.js`,
   `icon-192.png`, and `icon-512.png` at the root. No new env vars.

**Insurance Claims Center** (new Insurance tab): every policy as a claim card
with a 7-stage pipeline (Locating → Forms requested → Submitted → In review →
Approved → Paid / Denied), a 5-item required-documents checklist per claim,
expected-vs-received benefit totals, payout logging, and a lost-policy finder
guide (NAIC Policy Locator, premium-payment statement search, employer group
life, hidden AD&D on credit cards).

**Government Checklist** (inside the Notify tab): 12 pre-built agency cards —
SSA, IRS, state tax, DMV, State Dept (passport), VA, Medicare, Medicaid, NPRC
military records, pensions/PBGC, licensing boards, voter registration — each
with why it matters, what to send/have ready, and the phone number. "Track this"
adds it to the notification tracker with pending/sent/confirmed status.

**PWA**: the site is now installable — Add to Home Screen on iPhone/Android,
Install on desktop Chrome/Edge. Standalone window, HomegoingHQ icon, offline shell
(the app loads without signal; data still needs a connection). A polite install
banner appears once after sign-in and respects "Not now" permanently.

## Release 7 — White-Label Partners + State Pack System (included)

**To activate:** run `supabase-migration-v7.sql` (as admin), redeploy the folder.

**Partners (funeral homes, advisors, churches):** Admin console → Partners →
add one with a code. Their link is `https://yoursite.netlify.app/?p=CODE`.
Families arriving through it see an "In partnership with [Name]" badge (with
logo and accent color) on the sign-in page and dashboard; their signup and every
estate they create is attributed to the partner (counts show in Admin); and if
the partner has funeral home details, new estates get that funeral home
pre-filled and marked "chosen" in the Funeral tab. Suggested pricing: $149–199/mo
flat per location.

**State packs are now data, not code:** the Probate Assistant reads content from
the `state_packs` table (falling back to the built-in copy if the table is
unreachable). Edit Michigan, or add Indiana/Arizona/Alabama/NC, directly in
Admin → State packs — JSON editor with validation, version stamp, and an
attorney-credit field ("Reviewed by Jane Smith, IN probate attorney") that
displays in the app. Changes are live instantly, no redeploy. Start each new
state by clicking "+ New state" (it copies GENERIC as the template).

**County court directory:** factual court logistics (name, address, phone,
website, filing notes) shown as a "Find your probate court" picker in the
Probate tab. Three MI starter rows are seeded with placeholders — fill in
verified details from the official directory at courts.mi.gov via Admin →
County directory. Counties need no legal review; they're directory data.

## Release 8 — Gift Flow, Professional Portal, Plaid, E2EE (included)

**To activate:** run `supabase-migration-v8.sql`, redeploy. For Stripe gifts and
Plaid, add the env vars below.

**Gift flow:** "Give HomegoingHQ as a gift" appears on the sign-in page (works
signed-out) and the upgrade card. Buyer enters their email + recipient email +
message → Stripe checkout ($249, reuses STRIPE_PRICE_SETTLE) → the webhook
creates a GIFT-XXXXXXXX code and emails it to both parties → recipient signs up
free and uses "Redeem a gift code." Codes are single-use, server-enforced.

**Professional portal (v1):** estate invites and plan sharing now offer
Attorney / CPA / Financial advisor roles. Professionals see a "Your clients"
section at the top of their home screen listing every estate and plan where
they serve, with role badges — one account, all clients. (Same permissions as
members in v1; granular scoping is a future refinement.)

**Plaid bank import:** "Import from banks" button in Ledger → Assets
(Settle-gated). Privacy-by-design: the function fetches account names and
balances once, then immediately calls /item/remove — no bank connection is
stored, ever. Imported assets carry a note reminding the executor to adjust to
date-of-death balances. Env vars: `PLAID_CLIENT_ID`, `PLAID_SECRET`,
`PLAID_ENV` (start with `sandbox`; Plaid production requires their approval —
your WealthHQ compliance packet experience applies directly).

**E2EE "Sensitive lock":** the 🔒 button on any plan enables true end-to-end
encryption for every "number" field — AES-GCM with a key derived from the
user's passphrase (PBKDF2, 310k iterations), encrypted in the browser before
upload. The server stores only ciphertext. Unlock is per-session; the Executor
Packet respects lock state. The UI is explicit about the trade-off: lost
passphrase = numbers unrecoverable, no back door. Existing plaintext numbers
are encrypted in place when the lock is enabled.

## Env var reference (complete)
| Var | Needed for |
|---|---|
| ANTHROPIC_API_KEY | AI Guide, obituary builder |
| SITE_URL | links in emails, Stripe redirects |
| SENDGRID_API_KEY, FROM_EMAIL | invites, alerts, digests, gift emails |
| SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY | webhook tier updates, digest, gift codes |
| STRIPE_SECRET_KEY, STRIPE_PRICE_SETTLE, STRIPE_PRICE_PREMIUM, STRIPE_PRICE_VAULT, STRIPE_WEBHOOK_SECRET | payments, gifts & Vault Keeper |
| PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV | bank import |


## Release 10 — Last Wishes Witness (sealed video)

**To activate:**
1. Run `supabase-migration-v9.sql` (as admin) — everything except the two storage
   policies at the bottom.
2. Storage → New bucket → `witness-videos` → **Private** → then run those two
   storage policies.
3. Redeploy (updated index.html + send-invite.js).

**What it is:** the 🎥 "Last wishes" button on every plan. The person records on
camera (5-minute guided recording with a suggested sound-mind opening statement,
or uploads a file up to 80 MB). On sealing: a SHA-256 fingerprint is computed
in the browser, the video uploads to an immutable private bucket, the record is
written to a table with **no update and no delete policies for anyone** —
including admins — and the fingerprint certificate is emailed to witnesses the
person chooses (independent, timestamped anchoring in mailboxes you don't
control). Anyone with plan access can later hit **Verify**: the app re-downloads
the file, recomputes the hash, and declares it byte-for-byte unchanged or
failed. A printable **Certificate of Sealed Recording** documents the
fingerprint, timestamp, recipients, and verification instructions (including
the shasum/certutil commands so it can be verified outside the app forever).

**Honest limits, stated in the UI:** a video is not a will in most states; its
power is evidentiary — wishes, identity, and state of mind. Database owners at
the infrastructure level could theoretically alter data, which is exactly why
the emailed fingerprints exist: they make any alteration detectable.


## Release 11 — Music & Special Tributes (VisionWorks Entertainment)

**To activate:** run `supabase-migration-v10.sql`, redeploy (index.html +
send-invite.js). Optional env var: `TALENT_EMAIL` (defaults to
Info@VWEntertainment.com) — point it at your own inbox during testing so real
inquiries don't reach VisionWorks until the referral agreement is signed.

**What it is:** a "Music & special tributes" section in the Funeral tab —
soloists, musicians, choirs, repast hosts, special appearances, and personal
tribute videos from gospel/jazz/R&B artists. Families submit a request
(need, date, location, budget range, artist wishes, contact info); it's logged
with a status tracker (requested → contacted → booked) and emailed instantly to
VisionWorks with a branded referral header and reference ID, while the family
gets a warm confirmation with VWE's direct phone numbers. Copy is honest:
"no promises — they'll tell you honestly what's possible," and inquiring is free.

**Business to-dos before going live:** (1) a signed referral agreement with
Pam/VisionWorks — commission per booked engagement (10–15% of the booking fee is
customary in entertainment referrals) or a flat spotter's fee, in writing;
(2) tell her the emails are coming and agree on response-time expectations,
since the app promises "usually within one business day."


## Release 12 — Concierge (human hand-holding via VisionWorks)

**To activate:** redeploy only (index.html + send-invite.js). No SQL — concierge
requests reuse the talent_requests table (need_type `concierge_*`), so they
show up alongside talent requests and in the activity log.

**What it is:** a "Prefer a person beside you?" card at the top of Survivor
Mode's Next tab. Families choose a support level (a few unsticking calls →
funeral-week support → monthly coordination → full settlement support →
"help me figure out what I need"), urgency, and where things are stuck. The
request emails VisionWorks with a reference ID and a compliance reminder
(concierge = organizational/logistical; legal/tax/financial advice stays with
licensed professionals — this line protects everyone), and the family gets a
warm confirmation: first conversation free, everything quoted before it begins.

**Business model recommendation:** v1, VisionWorks quotes and bills families
directly; you take a referral percentage per engagement (put it in the same
written terms as talent bookings). Once volume proves out, productize it as a
priced Concierge tier inside the app and pay VWE as the fulfillment partner —
better margins, but only worth the billing complexity at scale. Track both
funnels by reference ID from day one.


## Release 13 — Free-Tier Tightening

**To activate:** run `supabase-migration-v11.sql` (adds an AI-usage counter and
its increment function), redeploy index.html.

**New free limits (Settle removes all of them):**
- AI Guide: 10 conversations lifetime (obituary drafts count) — metered
  server-side in profiles.ai_uses; the 10th message warns, the 11th shows an
  inline Unlock button. This is the cost-control gate: free users no longer
  generate unlimited Anthropic API spend.
- Documents: 10 uploads per estate.
- Ledger: 10 entries total across assets/debts/expenses/beneficiaries/
  distributions — enough to see the tool's value, not enough to settle with.
- Witness video: sealing is Settle-only (playing and verifying shared
  recordings stays free).
- Unchanged free: full roadmap + traditions, 2 members, 2 templates, memorial
  pages, probate assistant, funeral tools, and the VisionWorks/concierge
  buttons (those generate referral revenue — never gate them).

To reset a specific user's AI meter (support gesture):
`update profiles set ai_uses = 0 where email = '…';`
Marketing sites' pricing bullets updated to match — regenerated in
KinKeeper-Family-Marketing-Sites.zip.


## Release 14 — Three-Tier Ladder (Free / Companion $39 / Settle $249)

**To activate:**
1. Run `supabase-migration-v12.sql` (lets Admin grant the `companion` tier).
2. Stripe → Add product → `HomegoingHQ Companion` → **$39.00, One-off** → copy
   the Price ID → Netlify env var `STRIPE_PRICE_COMPANION` = that ID.
3. Redeploy the folder (index.html, sw.js, stripe-checkout.js changed).

**The ladder (all limits live in the LIMITS constant near the top of the app
script — tune freely):**

| | Free | Companion $39 | Settle $249 |
|---|---|---|---|
| Roadmap | First 72 hours only — later phases visible, locked 🔒 | All phases | All phases |
| Guide (AI) | 3 messages | 25 | Unlimited |
| Documents | 3 | 10 | Unlimited |
| Ledger | Locked | 10 entries | Unlimited + court reports |
| Templates | 1 | 2 | All 6 |
| Vault entries | 5 | 12 | Unlimited |
| Estates / plans / members | 1 / 1 / 2 | 1 / 1 / 2 | Unlimited |
| Witness sealing, Plaid, gift | — | — | ✅ |

Always free, deliberately: memorial pages (viral), probate quiz, funeral
tools, invites, and the VisionWorks/concierge buttons (referral revenue).

Every gate now opens one shared upgrade modal showing both paid tiers side by
side, so each paywall moment sells the ladder, not a single price. When a free
family finishes the first-72-hours steps, the card stack itself becomes the
pitch: "You've handled the urgent steps — N more are waiting on the road ahead."

The `premium` ($99/yr) plumbing remains dormant — not sold at launch.
