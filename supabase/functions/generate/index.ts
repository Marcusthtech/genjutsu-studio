// POST {workflow, resolution, prompt, video_url, image_urls} -> {job}
// Prices the request from the video's real length, holds the credits, submits to Higgsfield.
import {
  admin, deleteInputs, FALLBACK_USD_PER_SEC, getUser, HF_BASE, hfHeaders, INPUTS_PUBLIC, inputPath, json,
  mp4Duration, PRESETS_PUBLIC, RESOLUTIONS, serve, signInput, usdToCredits, WORKFLOWS,
} from "../_shared/common.ts";

serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);

  const b = await req.json().catch(() => ({}));
  const trend = /^[a-z0-9-]{1,40}$/.test(String(b.trend)) ? String(b.trend) : "custom";
  const workflow = String(b.workflow ?? "");
  const resolution = String(b.resolution ?? "720p");
  const prompt = String(b.prompt ?? "").slice(0, 2000);
  const video_url = String(b.video_url ?? "");
  const image_urls: string[] = Array.isArray(b.image_urls) ? b.image_urls.map(String) : [];
  const ownPrefix = `${INPUTS_PUBLIC}${user.id}/`;

  if (!WORKFLOWS.includes(workflow as never)) return json({ error: "Pick a mode." }, 400);
  if (!RESOLUTIONS.includes(resolution as never)) return json({ error: "Pick a resolution." }, 400);
  const isPreset = video_url.startsWith(PRESETS_PUBLIC) && /^[a-z0-9-]+\.mp4$/.test(video_url.slice(PRESETS_PUBLIC.length));
  if (!video_url.startsWith(ownPrefix) && !isPreset) {
    return json({ error: "Upload a source video." }, 400);
  }
  if (image_urls.length < 1 || image_urls.length > 8 || !image_urls.every((u) => u.startsWith(ownPrefix))) {
    return json({ error: "Add 1–8 reference images." }, 400);
  }

  // Test mode: allowlisted testers can fake the Higgsfield call (mock "ok" or "fail").
  // Credits are still charged and refunded so the whole money path is exercised.
  const mock = b.mock === "ok" || b.mock === "fail" ? b.mock : null;
  if (mock) {
    const testers = (Deno.env.get("TEST_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (!testers.includes(String(user.email ?? "").toLowerCase())) return json({ error: "Test mode is not enabled for this account." }, 403);
  }

  // Price from the file itself, never from what the browser says. Higgsfield bills per started
  // second of output (= source length, capped at 30s); ignore container padding under 50ms.
  const secs = await mp4Duration(video_url);
  if (secs === null) return json({ error: "We couldn't read that video. Please upload a standard MP4." }, 400);
  if (secs < 3.95) return json({ error: "The video must be at least 4 seconds." }, 400);
  const billed = Math.min(30, Math.max(4, Math.ceil(secs - 0.05)));
  const cost = usdToCredits(FALLBACK_USD_PER_SEC[resolution] * billed);
  if (b.quote_only) return json({ cost });

  const { data: ok } = await admin.rpc("spend_credits", { p_user: user.id, p_amount: cost });
  if (!ok) return json({ error: "Not enough credits.", cost }, 402);

  const { data: job, error } = await admin.from("jobs").insert({
    user_id: user.id, trend, workflow, resolution, prompt, video_url, image_urls, cost,
  }).select().single();
  if (error || !job) {
    await admin.rpc("spend_credits", { p_user: user.id, p_amount: -cost }); // give the hold back
    return json({ error: "Could not create job." }, 500);
  }

  if (mock) {
    const { data: saved } = await admin.from("jobs")
      .update({ hf_request_id: `mock:${mock}:${job.id}`, status: "queued", updated_at: new Date().toISOString() })
      .eq("id", job.id).select().single();
    return json({ job: saved });
  }

  const fail = async (msg: string, status: number) => {
    await admin.from("jobs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", job.id);
    await admin.rpc("refund_job", { p_job: job.id });
    await deleteInputs(job);
    return json({ error: `${msg} Your credits were refunded.` }, status);
  };

  // Uploads live in a private bucket: hand Higgsfield short-lived signed URLs.
  let input;
  try {
    const sign = (u: string) => (inputPath(u) ? signInput(inputPath(u)!) : Promise.resolve(u));
    input = { video_url: await sign(video_url), image_urls: await Promise.all(image_urls.map(sign)), prompt, resolution };
  } catch (e) {
    console.error("signing failed", e);
    return fail("The generation service is unavailable right now. Please try again later.", 502);
  }

  const endpoint = `higgsfield/genjutsu/${workflow}/v1.0`;
  const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hf-webhook?secret=${Deno.env.get("WEBHOOK_SECRET")}`;
  let r: Response | null = null, sub: Record<string, unknown> = {};
  // The Idempotency-Key makes one retry after a network error safe (no double render).
  for (let attempt = 0; attempt < 2 && !r; attempt++) {
    try {
      r = await fetch(`${HF_BASE}/${endpoint}?hf_webhook=${encodeURIComponent(hook)}`, {
        method: "POST", headers: hfHeaders({ "Idempotency-Key": job.id }), body: JSON.stringify(input),
      });
      sub = await r.json().catch(() => ({}));
    } catch (e) { console.error("higgsfield submit threw", e); }
  }
  if (!r || !r.ok || !sub.request_id) {
    console.error("higgsfield submit failed", r?.status, JSON.stringify(sub));
    // 4xx other than auth usually means bad input the user can fix; everything else is on us.
    return fail(r?.status === 422 || r?.status === 400
      ? "The video or photos weren't accepted. Check the video is 4–30s MP4 and try again."
      : "The generation service is unavailable right now. Please try again later.", 502);
  }

  const { data: saved } = await admin.from("jobs")
    .update({ hf_request_id: sub.request_id, status: sub.status ?? "queued", updated_at: new Date().toISOString() })
    .eq("id", job.id).select().single();
  return json({ job: saved });
});
