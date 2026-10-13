# Open issues

Known gaps we've decided to leave for now.

- **Generated videos live on Higgsfield's CDN, not ours.** `jobs.output_url` points at Higgsfield's storage and we don't know their retention. If they delete old outputs, "Your videos" shows broken players after a few weeks. Fix: on `completed`, copy the MP4 into Supabase storage (`outputs/<user>/<job>.mp4`, ~5 MB each) and store that URL instead.
- **No custom SMTP.** Supabase's built-in mailer sends ~2 emails/hour, so sign-in links stall under real traffic.
- **PayPal is still sandbox.** Switch to live client ID/secret before launch.
- **No Terms / Privacy / Refund pages**, and no "I have permission to use these photos" consent checkbox.
- **Higgsfield balance has no auto top-up or low-balance alert.**
- **Watermarked source clips:** Alors on Danse, Industry Baby, Shrek Raindance.
