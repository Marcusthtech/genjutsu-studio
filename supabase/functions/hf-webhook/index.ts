// Higgsfield completion webhook. The payload is only a hint: we re-read the
// authoritative status from Higgsfield before touching the job.
import { admin, json, safeEqual, syncJob, serve } from "../_shared/common.ts";

serve(async (req) => {
  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get("secret") ?? "", Deno.env.get("WEBHOOK_SECRET") ?? "x")) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => null);
  if (!body?.request_id) return json({ error: "bad payload" }, 400);

  const { data: job } = await admin.from("jobs").select("*").eq("hf_request_id", body.request_id).maybeSingle();
  if (job) await syncJob(job);
  return json({ ok: true });
});
