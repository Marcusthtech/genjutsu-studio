# Genjutsu Studio

Viral AI video trends made with Higgsfield's **Genjutsu**. Each trend gets its own page (`/trends/<slug>/`) with the
scene locked in, so users only add the photos. `/custom/` lets users bring their own video, up to 8 photos and a prompt.

## Add a new trend
1. Upload the clip and a poster frame to Supabase storage bucket `presets` as `<slug>.mp4` (public; the `inputs` bucket is private).
2. Add an entry to `site/trends.json` (copy `white-chicks`: slots, prompt, duration, SEO texts, steps, FAQ).
3. Optional: a 1200×630 share image at `docs/trends/<slug>/og.jpg` (falls back to the poster).
4. `python3 site/build.py` → regenerates home, trend pages, custom, sitemap. Commit + push.

Pages in `docs/` other than `app.js`, `config.js`, `styles.css` are generated, so edit `site/` rather than the HTML.

Pay-as-you-go web front for Higgsfield's **Genjutsu** video model (motion transfer + object swap).
Visitors sign in with email, buy credits via PayPal, and generate videos. No subscription.

- **Frontend**: static site in `docs/` → GitHub Pages. Runs in *demo mode* until `docs/config.js` is filled.
- **Backend**: Supabase (Auth + Postgres + Storage + 4 Edge Functions). Needed because the Higgsfield
  and PayPal secrets must never reach the browser.

## How it works
1. User uploads video + photo(s) → Supabase Storage bucket `inputs/<user_id>/…` (public URLs).
2. `generate` asks Higgsfield's `/estimate` for the real USD cost, converts to credits
   (`1 credit = $0.01 retail`, `retail = cost × HF_DISCOUNT × MARKUP + FEE_USD`), atomically deducts, submits with
   `Idempotency-Key = job id` and a webhook.
3. The job row lives in Postgres, so refreshing/closing the page never loses it. The page polls `jobs`;
   Higgsfield also calls `hf-webhook`. Both re-read the authoritative status from Higgsfield.
4. `failed` / `nsfw` / `canceled` → credits refunded exactly once (`refund_job`).
5. `paypal` creates the order server-side at a fixed pack price and credits the account only after a
   verified capture (idempotent `complete_payment`). Money lands in your PayPal account.

## Setup (~15 min)
1. **Supabase**: create a project. SQL editor → run `supabase/migrations/001_init.sql`.
   Auth → URL configuration → add your Pages URL to *Site URL* / *Redirect URLs*.
   (Optional) Auth → Email templates → Magic link: add `{{ .Token }}` so users also get a 6-digit code.
2. **Higgsfield**: https://open.higgsfield.ai → top up balance → create API key (id + secret).
3. **PayPal**: https://developer.paypal.com → Apps & Credentials → create app (Sandbox first, then Live).
4. **Deploy functions** (`brew install supabase/tap/supabase`):
   ```bash
   supabase login && supabase link --project-ref <ref>
   supabase secrets set HF_API_KEY_ID=… HF_API_KEY_SECRET=… \
     PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… PAYPAL_ENV=sandbox \
     WEBHOOK_SECRET=$(openssl rand -hex 24) MARKUP=1.5 \
     ALLOWED_ORIGIN=https://genjutsu-trends.com,https://www.genjutsu-trends.com
   supabase functions deploy paypal generate jobs hf-webhook
   ```
5. Fill `docs/config.js` with the Supabase URL, anon key and PayPal **client id** (public values), push.
   Keep `PACKS` in sync with `supabase/functions/paypal/index.ts`, and `CREDITS_PER_SEC` ≈ rate × HF_DISCOUNT × MARKUP × 100 and `FEE_CREDITS` = FEE_USD × 100.
6. Test with PayPal sandbox buyer account → switch `PAYPAL_ENV=live` + live client id/secret.

## Pricing reference (Higgsfield, Sept 2026)
480p $0.318/s · 720p $0.681/s · 1080p $1.632/s. Source video 4–30 s, 1–8 reference images.
