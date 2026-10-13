# Open issues

Known gaps we've decided to leave for now.

- **Generated videos live on Higgsfield's CDN, not ours.** `jobs.output_url` points at Higgsfield's storage and we don't know their retention. If they delete old outputs, "Your videos" shows broken players after a few weeks. Fix: on `completed`, copy the MP4 into Supabase storage (`outputs/<user>/<job>.mp4`, ~5 MB each) and store that URL instead.
- **No custom SMTP.** Supabase's built-in mailer sends ~2 emails/hour, so sign-in links stall under real traffic.
- **PayPal is still sandbox.** Switch to live client ID/secret before launch.
- **No Terms / Privacy / Refund pages**, and no "I have permission to use these photos" consent checkbox.
- **Higgsfield balance has no auto top-up or low-balance alert.**
- **Watermarked source clips:** Alors on Danse, Industry Baby, Shrek Raindance.
- **Sign-in by code is built but off** (`EMAIL_CODE` in `docs/config.js`). Supabase's free plan won't let us edit email templates without custom SMTP. Once SMTP is set up: add `{{ .Token }}` to the Magic Link + Confirm signup templates, then set `EMAIL_CODE: true`. Until then photos survive the sign-in link through an IndexedDB draft (same browser only, so not from inside a mail app).
- **No captcha on sign-in.** Enable Cloudflare Turnstile together with custom SMTP.
- **PayPal webhook is registered for sandbox only.** When switching to live, register `…/functions/v1/paypal-webhook` (events PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED) on the live app and set `PAYPAL_WEBHOOK_ID` to the live ID.
