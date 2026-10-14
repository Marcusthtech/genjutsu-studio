import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "https://genjutsu-trends.com").split(",").map((s) => s.trim());

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

// ---------- storage ----------
const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const INPUTS_PUBLIC = `${SB_URL}/storage/v1/object/public/inputs/`; // URL shape the client sends
export const PRESETS_PUBLIC = `${SB_URL}/storage/v1/object/public/presets/`;
const srk = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Object path inside the private "inputs" bucket for a client-sent URL, or null. */
export const inputPath = (url: string) => (url.startsWith(INPUTS_PUBLIC) ? url.slice(INPUTS_PUBLIC.length) : null);

/** Short-lived signed URL Higgsfield can fetch a private input from. */
export async function signInput(path: string): Promise<string> {
  const { data, error } = await admin.storage.from("inputs").createSignedUrl(path, 6 * 3600);
  if (error || !data) throw new Error(`sign failed: ${error?.message}`);
  return data.signedUrl;
}

/** Inputs are only needed until Higgsfield has rendered; delete the user's uploads then. */
export async function deleteInputs(job: { video_url?: string; image_urls?: unknown }) {
  const urls = [job.video_url, ...(Array.isArray(job.image_urls) ? job.image_urls : [])].map(String);
  const paths = urls.map(inputPath).filter((x): x is string => !!x);
  if (paths.length) await admin.storage.from("inputs").remove(paths).catch(() => {});
}

/**
 * Duration in seconds of an MP4/MOV, read from its moov/mvhd box with ranged GETs, so the
 * price never depends on what the browser claims. Returns null if it can't be read.
 */
export async function mp4Duration(url: string): Promise<number | null> {
  const path = inputPath(url);
  const src = path ? `${SB_URL}/storage/v1/object/authenticated/inputs/${path}` : url;
  const headers = path ? { Authorization: `Bearer ${srk()}`, apikey: srk() } : {};
  const range = async (from: number, to: number) => {
    const r = await fetch(src, { headers: { ...headers, Range: `bytes=${from}-${to}` } });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  };
  let off = 0;
  for (let i = 0; i < 64; i++) {
    const h = await range(off, off + 15);
    if (!h || h.length < 8) return null;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(...h.slice(4, 8));
    let hdr = 8;
    if (size === 1) { if (h.length < 16) return null; size = Number(dv.getBigUint64(8)); hdr = 16; }
    if (size < hdr) return null; // size 0 ("to end of file") never wraps a moov we can find
    if (type === "moov") {
      const moov = await range(off + hdr, off + Math.min(size, 8 * 1024 * 1024) - 1);
      return moov ? moovDuration(moov) : null;
    }
    off += size;
  }
  return null;
}

/**
 * Presented length of the movie: the longest of the movie header and each track header.
 * A track with no edit list plays its whole media, so its media header (mdhd) counts too;
 * with an edit list the media may be longer than what plays, so it doesn't.
 * Fragmented MP4s (mvex) keep the real length in the fragments and are rejected, not priced.
 */
function moovDuration(moov: Uint8Array): number | null {
  let best = 0, movieScale = 0;
  const box = (j: number, end: number) => {
    if (j + 8 > end) return null;
    const m = new DataView(moov.buffer, moov.byteOffset + j, end - j);
    const size = m.getUint32(0);
    if (size < 8 || j + size > end) return null; // truncated (moov over 8 MB): stop here
    return { m, size, type: String.fromCharCode(...moov.slice(j + 4, j + 8)), v: moov[j + 8] };
  };
  const hd = (b: { m: DataView; v: number }) => // mvhd/mdhd: [timescale, duration]
    b.v === 1 ? [b.m.getUint32(28), Number(b.m.getBigUint64(32))] : [b.m.getUint32(20), b.m.getUint32(24)];
  for (let j = 0, b; (b = box(j, moov.length)); j += b.size) {
    if (b.type === "mvex") return null;
    if (b.type === "mvhd") {
      const [ts, d] = hd(b);
      if (!ts) return null;
      movieScale = ts;
      best = Math.max(best, d / ts);
    } else if (b.type === "trak" && movieScale) {
      let edited = false, media = 0;
      const tEnd = j + b.size;
      for (let k = j + 8, c; (c = box(k, tEnd)); k += c.size) {
        if (c.type === "edts") edited = true;
        if (c.type === "tkhd") best = Math.max(best, (c.v === 1 ? Number(c.m.getBigUint64(36)) : c.m.getUint32(28)) / movieScale);
        if (c.type === "mdia") {
          for (let l = k + 8, e; (e = box(l, k + c.size)); l += e.size) {
            if (e.type === "mdhd") { const [ts, d] = hd(e); if (ts) media = d / ts; }
          }
        }
      }
      if (!edited) best = Math.max(best, media);
    }
  }
  return movieScale ? best : null;
}

/** Fetch status from Higgsfield, persist it on the job, refund on failure. */
export async function syncJob(job: Job) {
  if (!job.hf_request_id || TERMINAL.has(job.status)) return job;
  if (job.hf_request_id.startsWith("mock:")) return syncMockJob(job);
  const r = await fetch(`${HF_BASE}/requests/${job.hf_request_id}/status`, { headers: hfHeaders() });
  if (!r.ok) return job;
  const s = await r.json();
  const patch: Record<string, unknown> = { status: s.status, updated_at: new Date().toISOString() };
  if (s.video?.url) patch.output_url = s.video.url;
  if (s.error) { // users see a plain message; the provider's raw text stays in the logs
    console.error("higgsfield job failed", job.id, String(s.error).slice(0, 500));
    patch.error = "The render failed. Your credits were refunded.";
  }
  if (s.status === "nsfw") patch.error = "The content was flagged by moderation. Your credits were refunded.";
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (["failed", "nsfw", "canceled"].includes(s.status)) await admin.rpc("refund_job", { p_job: job.id });
  if (TERMINAL.has(s.status)) await deleteInputs(job);
  if (s.status === "completed" && s.video?.url && job.billed_secs) { // pricing sanity check
    const out = await mp4Duration(s.video.url).catch(() => null);
    if (out && out > job.billed_secs + 1) console.warn("output longer than billed", job.id, out, job.billed_secs);
  }
  return data ?? job;
}

type Job = { id: string; hf_request_id: string | null; status: string; created_at?: string; video_url?: string; image_urls?: unknown; billed_secs?: number | null };
const MOCK_OUTPUT = `${PRESETS_PUBLIC}qa-4s.mp4`;

/** Test-mode jobs: queued -> in_progress -> completed/failed over ~20s, no Higgsfield call. */
async function syncMockJob(job: Job) {
  const age = Date.now() - new Date(job.created_at ?? Date.now()).getTime();
  const fail = job.hf_request_id!.startsWith("mock:fail");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (age < 8000) patch.status = "queued";
  else if (age < 20000) patch.status = "in_progress";
  else if (fail) Object.assign(patch, { status: "failed", error: "Test mode: simulated failure. Your credits were refunded." });
  else Object.assign(patch, { status: "completed", output_url: MOCK_OUTPUT });
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (patch.status === "failed") await admin.rpc("refund_job", { p_job: job.id });
  if (TERMINAL.has(String(patch.status))) await deleteInputs(job);
  return data ?? job;
}

/** Constant-time string compare for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
