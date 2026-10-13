import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim());

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ORIGINS.includes("*") ? "*" : ORIGINS.includes(origin) ? origin : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    Vary: "Origin",
  };
}

/** Deno.serve with CORS preflight + CORS headers on every response. */
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    const cors = corsFor(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    const res = await handler(req);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const admin: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/** Resolve the calling user from the bearer token, or null. */
export async function getUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

// ---------- Higgsfield ----------
export const HF_BASE = "https://api.higgsfield.ai";
export const WORKFLOWS = ["motion-transfer", "object-swap"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
// USD per second of output, used only when the estimate endpoint is unavailable.
export const FALLBACK_USD_PER_SEC: Record<string, number> = { "480p": 0.318, "720p": 0.681, "1080p": 1.632 };
export const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);

export function hfHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Key ${Deno.env.get("HF_API_KEY_ID")}:${Deno.env.get("HF_API_KEY_SECRET")}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** 1 credit = $0.01 retail. Retail = list cost x HF_DISCOUNT x MARKUP + FEE_USD per video. */
export function usdToCredits(usd: number): number {
  const discount = Number(Deno.env.get("HF_DISCOUNT") ?? "1");
  const markup = Number(Deno.env.get("MARKUP") ?? "1.5");
  const fee = Number(Deno.env.get("FEE_USD") ?? "0");
  return Math.max(1, Math.ceil(usd * discount * markup * 100) + Math.round(fee * 100));
}

/** Fetch status from Higgsfield, persist it on the job, refund on failure. */
export async function syncJob(job: { id: string; hf_request_id: string | null; status: string; created_at?: string; video_url?: string }) {
  if (!job.hf_request_id || TERMINAL.has(job.status)) return job;
  if (job.hf_request_id.startsWith("mock:")) return syncMockJob(job);
  const r = await fetch(`${HF_BASE}/requests/${job.hf_request_id}/status`, { headers: hfHeaders() });
  if (!r.ok) return job;
  const s = await r.json();
  const patch: Record<string, unknown> = { status: s.status, updated_at: new Date().toISOString() };
  if (s.video?.url) patch.output_url = s.video.url;
  if (s.error) patch.error = String(s.error).slice(0, 500);
  if (s.status === "nsfw") patch.error = "The content was flagged by moderation. Your credits were refunded.";
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (["failed", "nsfw", "canceled"].includes(s.status)) await admin.rpc("refund_job", { p_job: job.id });
  return data ?? job;
}

/** Test-mode jobs: queued -> in_progress -> completed/failed over ~20s, no Higgsfield call. */
async function syncMockJob(job: { id: string; hf_request_id: string | null; status: string; created_at?: string; video_url?: string }) {
  const age = Date.now() - new Date(job.created_at ?? Date.now()).getTime();
  const fail = job.hf_request_id!.startsWith("mock:fail");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (age < 8000) patch.status = "queued";
  else if (age < 20000) patch.status = "in_progress";
  else if (fail) Object.assign(patch, { status: "failed", error: "Test mode: simulated failure. Your credits were refunded." });
  else Object.assign(patch, { status: "completed", output_url: job.video_url });
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (patch.status === "failed") await admin.rpc("refund_job", { p_job: job.id });
  return data ?? job;
}
