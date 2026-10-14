import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Shared by every page. window.PAGE (inlined by site/build.py) says which page this is:
//   { kind: "home" }                       trend gallery + "Your videos"
//   { kind: "trend", trend: {...} }        locked scene, user only adds the photo slots
//   { kind: "custom" }                     own video, up to 8 photos, own prompt
const C = window.GENJUTSU_CONFIG;
const PAGE = window.PAGE || { kind: "home" };
const T = PAGE.trend;
const HAS_STUDIO = PAGE.kind === "trend" || PAGE.kind === "custom";
const DEMO = !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY;
// Test mode (?mock=ok or ?mock=fail): the server fakes the render for allowlisted testers only.
const MOCK = ["ok", "fail"].includes(new URLSearchParams(location.search).get("mock")) ? new URLSearchParams(location.search).get("mock") : null;
if (MOCK && HAS_STUDIO) {
  const b = document.createElement("div");
  b.className = "test-banner";
  b.textContent = `TEST MODE (${MOCK === "ok" ? "simulated success" : "simulated failure"}) · no real render, credits are charged${MOCK === "fail" ? " then refunded" : ""}`;
  document.body.prepend(b);
}
const sb = DEMO ? null : createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

const state = {
  mode: T?.mode || "motion-transfer", res: T?.resolution || "480p",
  video: null, duration: 0,
  images: T ? T.slots.map(() => null) : [], // trend: fixed slots (File|null); custom: File[]
  user: null, credits: 0, jobs: [], pendingGenerate: false, pack: C.PACKS[1].id,
  started: false, // this exact set of inputs was already sent (guards against paying twice)
};

// ---------------- helpers ----------------
function toast(msg, ms = 3500) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
// Browsers report a few ms extra (AAC priming), so ignore anything under 0.05s past a whole second.
const clampSecs = (d) => Math.min(30, Math.max(4, Math.ceil(d - 0.05)));
function estimate() {
  return state.duration ? Math.ceil(clampSecs(state.duration) * C.CREDITS_PER_SEC[state.res]) + (C.FEE_CREDITS || 0) : 0;
}
async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    const e = new Error(msg); e.status = error.context?.status; throw e;
  }
  return data;
}
const demoStore = {
  get() { try { return JSON.parse(localStorage.getItem("gj-demo") || "null") || { credits: 0, jobs: [], email: null }; } catch { return { credits: 0, jobs: [], email: null }; } },
  set(v) { try { localStorage.setItem("gj-demo", JSON.stringify(v)); } catch {} },
};

// ---------------- draft (survives the sign-in link opening a fresh page) ----------------
// Photos (and a custom video) are saved in IndexedDB before sign-in and restored on return.
const draftDB = () => new Promise((res, rej) => {
  const r = indexedDB.open("gj", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("drafts");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function draftOp(mode, fn) {
  try {
    const db = await draftDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction("drafts", mode); const req = fn(tx.objectStore("drafts"));
      tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error);
    });
  } catch { return undefined; }
}
const saveDraft = () => draftOp("readwrite", (st) => st.put({
  at: Date.now(), res: state.res, mode: state.mode, images: state.images,
  video: state.video instanceof File ? state.video : null, prompt: $("prompt")?.value || "",
}, location.pathname));
async function restoreDraft() {
  const d = await draftOp("readonly", (st) => st.get(location.pathname));
  if (!d) return;
  draftOp("readwrite", (st) => st.delete(location.pathname));
  if (Date.now() - d.at > 2 * 3600 * 1000) return;
  if (T && d.images?.length === state.images.length) state.images = d.images;
  if (!T) { state.images = d.images || []; if (d.video) setVideo(d.video); if ($("prompt")) $("prompt").value = d.prompt; }
  selectMode(d.mode || state.mode); selectRes(d.res || state.res);
  renderThumbs(); refresh();
  if (photos().length) toast("Your photos are back. Hit Generate when you're ready.", 5000);
}

// ---------------- auth ----------------
async function initAuth() {
  if (DEMO) {
    $("demo-banner").hidden = false;
    const d = demoStore.get();
    if (d.email) setUser({ id: "demo", email: d.email });
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) setUser(data.session.user);
  sb.auth.onAuthStateChange((_e, session) => {
    if (session?.user && session.user.id !== state.user?.id) setUser(session.user);
    if (!session) setUser(null);
  });
}
async function setUser(user) {
  state.user = user;
  $("signin-btn").hidden = !!user;
  $("signout-btn").hidden = !user;
  $("credits-pill").hidden = !user;
  if (!user) { state.jobs = []; renderJobs(); refresh(); return; }
  const resume = state.pendingGenerate; state.pendingGenerate = false;
  $("signin-modal").open && $("signin-modal").close();
  await Promise.all([loadCredits(), loadJobs()]);
  if (resume) generate();
}
async function loadCredits() {
  if (DEMO) state.credits = demoStore.get().credits;
  else {
    const { data } = await sb.from("profiles").select("credits").eq("user_id", state.user.id).maybeSingle();
    state.credits = data?.credits ?? 0;
  }
  $("credits-val").textContent = state.credits.toLocaleString();
  refresh();
}

on("signin-btn", "click", () => openSignin());
on("signout-btn", "click", async () => {
  if (DEMO) { const d = demoStore.get(); d.email = null; demoStore.set(d); setUser(null); }
  else await sb.auth.signOut();
});
function openSignin() {
  $("signin-step1").hidden = false; $("signin-step2").hidden = true; $("signin-err").textContent = "";
  $("signin-modal").showModal(); $("email").focus();
}
// Closing the dialog without signing in cancels the "sign in & generate" intent.
on("signin-modal", "close", () => { if (!state.user) state.pendingGenerate = false; });
// The emailed code signs in on this page, so photos already added are kept (the link opens a new page).
on("verify-code", "click", async () => {
  const token = $("otp").value.replace(/\D/g, "");
  if (token.length < 6) return ($("signin-err").textContent = "Enter the code from the email.");
  $("verify-code").disabled = true; $("signin-err").textContent = "";
  try {
    const { error } = await sb.auth.verifyOtp({ email: $("sent-to").textContent, token, type: "email" });
    if (error) throw error;
  } catch (e) { $("signin-err").textContent = /expired|invalid/i.test(e.message) ? "That code is wrong or expired." : e.message; }
  finally { $("verify-code").disabled = false; }
});
on("otp", "keydown", (e) => { if (e.key === "Enter") $("verify-code").click(); });
on("email", "keydown", (e) => { if (e.key === "Enter") $("send-link").click(); });
on("send-link", "click", async () => {
  const email = $("email").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return ($("signin-err").textContent = "Enter a valid email.");
  $("send-link").disabled = true;
  try {
    if (DEMO) {
      const d = demoStore.get(); d.email = email; demoStore.set(d);
      return setUser({ id: "demo", email });
    }
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    $("sent-to").textContent = email;
    $("signin-step1").hidden = true; $("signin-step2").hidden = false;
    $("step2-code").hidden = !C.EMAIL_CODE; $("step2-link").hidden = !!C.EMAIL_CODE;
    if (C.EMAIL_CODE) { $("otp").value = ""; $("otp").focus(); }
  } catch (e) { $("signin-err").textContent = e.message; }
  finally { $("send-link").disabled = false; }
});

// ---------------- studio inputs ----------------
function showVideo(src, onReady) {
  const v = $("video-preview");
  v.src = src;
  v.onloadedmetadata = () => {
    if (v.duration < 3.95) { toast("The video must be at least 4 seconds."); return clearVideo(); }
    if (v.duration > 30) toast("Only the first 30 seconds will be used.");
    state.duration = v.duration; onReady();
    v.hidden = false; v.play().catch(() => {});
    const empty = $("video-drop").querySelector(".drop-empty"); if (empty) empty.hidden = true;
    if ($("video-clear")) $("video-clear").hidden = false;
    refresh();
  };
}
function setVideo(file) {
  if (!file || T) return;
  state.started = false;
  if (file.type !== "video/mp4") return toast("Please use an MP4 video.");
  showVideo(URL.createObjectURL(file), () => { state.video = file; });
}
function clearVideo() {
  if (T) return;
  state.video = null; state.duration = 0;
  const v = $("video-preview"); v.hidden = true; v.removeAttribute("src");
  $("video-drop").querySelector(".drop-empty").hidden = false; $("video-clear").hidden = true;
  $("video-input").value = ""; refresh();
}
on("video-input", "change", (e) => setVideo(e.target.files[0]));
on("video-clear", "click", (e) => { e.preventDefault(); clearVideo(); });

function selectMode(mode) {
  state.started = false;
  document.querySelectorAll(".mode").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  state.mode = mode;
}
function selectRes(res) {
  state.started = false;
  document.querySelectorAll("#res-seg button").forEach((x) => x.classList.toggle("active", x.dataset.res === res));
  state.res = res;
}

const photos = () => state.images.filter(Boolean);
function addImages(files, slot) {
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast("Use JPG, PNG or WEBP images."); continue; }
    if (T) {
      const i = slot ?? state.images.findIndex((x) => !x);
      if (i < 0) break;
      state.images[i] = f; slot = undefined;
    } else {
      if (state.images.length >= 8) { toast("Up to 8 photos."); break; }
      state.images.push(f);
    }
  }
  state.started = false; renderThumbs(); refresh();
}
let pickSlot;
function pickImage(slot) { pickSlot = slot; $("image-input").multiple = slot === undefined; $("image-input").click(); }
function renderThumbs() {
  const box = $("thumbs"); box.innerHTML = "";
  box.classList.toggle("slots", !!T);
  box.classList.toggle("many", !!T && T.slots.length > 4);
  const show = !!T || state.images.length > 0;
  box.hidden = !show; $("image-empty").hidden = show;
  state.images.forEach((f, i) => {
    const d = document.createElement("div");
    if (!f) {
      const ex = T.slots[i].example;
      d.className = "thumb slot" + (ex ? " has-example" : "");
      d.innerHTML = `${ex ? `<img class="slot-example" alt="" /><span class="example-tag">Example</span>` : ""}
        <span class="slot-cta"><span class="slot-plus">+</span><span class="slot-label"></span><span class="slot-hint"></span><span class="slot-add">Add photo</span></span>`;
      if (ex) d.querySelector(".slot-example").src = ex;
      d.querySelector(".slot-label").textContent = T.slots[i].label;
      d.querySelector(".slot-hint").textContent = T.slots[i].hint || "";
      d.tabIndex = 0; d.setAttribute("role", "button");
      d.setAttribute("aria-label", `Add photo: ${T.slots[i].label}`);
      d.onclick = (e) => { e.stopPropagation(); pickImage(i); };
      d.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickImage(i); } };
    } else {
      d.className = "thumb";
      d.innerHTML = `<img alt="" /><button class="x" aria-label="Remove photo">×</button>`;
      d.querySelector("img").src = URL.createObjectURL(f);
      if (T) { const l = document.createElement("span"); l.className = "slot-tag"; l.textContent = T.slots[i].label; d.appendChild(l); }
      d.querySelector("button").onclick = (e) => {
        e.stopPropagation();
        if (T) state.images[i] = null; else state.images.splice(i, 1);
        state.started = false; renderThumbs(); refresh();
      };
    }
    box.appendChild(d);
  });
  if (!T && state.images.length && state.images.length < 8) {
    const a = document.createElement("button"); a.className = "thumb add"; a.textContent = "+";
    a.onclick = (e) => { e.stopPropagation(); pickImage(); };
    box.appendChild(a);
  }
}
on("image-drop", "click", () => { if (!T && !state.images.length) pickImage(); });
if (HAS_STUDIO && !T) { // custom page: the empty photo zone is a click target too
  const z = $("image-drop"); z.tabIndex = 0; z.setAttribute("role", "button"); z.setAttribute("aria-label", "Add reference photos");
  z.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === z && !state.images.length) { e.preventDefault(); pickImage(); } });
}
on("image-input", "change", (e) => { addImages([...e.target.files], pickSlot); pickSlot = undefined; e.target.value = ""; });

if (HAS_STUDIO) {
  const zones = [["image-drop", (fs) => addImages(fs)]];
  if (!T) {
    zones.push(["video-drop", (fs) => setVideo(fs[0])]);
    const vd = $("video-drop"); // a <label> around a hidden input isn't focusable on its own
    vd.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === vd) { e.preventDefault(); $("video-input").click(); } });
    on("prompt", "input", () => { state.started = false; refresh(); }); // new prompt = new video
  }
  for (const [zone, handler] of zones) {
    const z = $(zone);
    z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
    z.addEventListener("dragleave", () => z.classList.remove("over"));
    z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); handler([...e.dataTransfer.files]); });
  }
  document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => { selectMode(b.dataset.mode); refresh(); }));
  document.querySelectorAll("#res-seg button").forEach((b) => (b.onclick = () => { selectRes(b.dataset.res); refresh(); }));
}

function refresh() {
  if (!HAS_STUDIO) return;
  const cost = estimate();
  const rate = C.CREDITS_PER_SEC[state.res];
  $("cost").innerHTML = cost ? `≈ <b>${cost.toLocaleString()} credits</b> <span>($${(cost / 100).toFixed(2)})</span>` : "Add a video to see the price";
  const bd = $("breakdown");
  bd.hidden = !cost;
  if (cost) {
    const bal = state.user
      ? (state.credits >= cost
        ? `You have <b>${state.credits.toLocaleString()}</b> credits, so <b>${(state.credits - cost).toLocaleString()}</b> will be left after this video.`
        : `You have <b>${state.credits.toLocaleString()}</b> credits. You need <b>${(cost - state.credits).toLocaleString()}</b> more.`)
      : "Sign in to see your balance.";
    bd.innerHTML = `<div class="bd-math"><span>${clampSecs(state.duration)} sec video</span><span>×</span><span>${rate} credits/sec at ${state.res}</span>${C.FEE_CREDITS ? `<span>+</span><span>${C.FEE_CREDITS} per video</span>` : ""}<span>=</span><b>${cost.toLocaleString()} credits</b></div>
      <div class="bd-note">Output length matches the source video (max 30 s). ${bal} Credits are held when you start and refunded automatically if it fails.</div>`;
  }
  const need = T ? (T.min_photos ?? state.images.length) : 1;
  const have = photos().length;
  const ready = state.video && have >= need;
  const btn = $("generate-btn");
  btn.disabled = !ready;
  btn.textContent = !ready
    ? (!state.video ? (T ? "Loading scene…" : "Upload a video to start") : T ? `Add ${need - have} more photo${need - have > 1 ? "s" : ""}` : "Add a reference photo")
    : !state.user ? "Sign in & generate" : state.credits < cost ? "Buy credits & generate"
    : state.started ? `Started ✓ · Generate again (${cost.toLocaleString()} credits)` : `Generate · ${cost.toLocaleString()} credits`;
}

// ---------------- generate ----------------
on("generate-btn", "click", () => generate());
async function upload(file) {
  const EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = EXT[file.type] || (file.name.split(".").pop() || "bin").toLowerCase();
  const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from("inputs").upload(path, file, { contentType: file.type });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return sb.storage.from("inputs").getPublicUrl(path).data.publicUrl;
}
let busy = false;
async function generate() {
  if (!HAS_STUDIO || !state.video || !photos().length || busy) return;
  if (!state.user) { state.pendingGenerate = true; saveDraft(); return openSignin(); }
  const cost = estimate();
  if (state.credits < cost) { state.pendingGenerate = true; return openBuy(`This video costs about ${cost.toLocaleString()} credits. You have ${state.credits.toLocaleString()}.`); }

  if (state.started && !confirm(`You already started this exact video. Make it again for ${cost.toLocaleString()} credits?`)) return;

  busy = true;
  const btn = $("generate-btn"); btn.disabled = true; btn.textContent = "Uploading…";
  const trend = T?.slug || "custom";
  try {
    let job;
    if (DEMO) {
      const d = demoStore.get();
      d.credits -= cost;
      job = { id: crypto.randomUUID(), trend, workflow: state.mode, resolution: state.res, cost, status: "queued",
        created_at: new Date().toISOString(), output_url: null, demo_done_at: Date.now() + 15000 };
      d.jobs.unshift(job); demoStore.set(d);
    } else {
      const [video_url, ...image_urls] = await Promise.all([
        state.video instanceof File ? upload(state.video) : state.video.url, ...photos().map(upload)]);
      btn.textContent = "Starting…";
      ({ job } = await callFn("generate", {
        trend, workflow: state.mode, resolution: state.res,
        prompt: T ? T.prompt : $("prompt").value.trim(),
        video_url, image_urls, duration: state.duration, ...(MOCK ? { mock: MOCK } : {}),
      }));
    }
    state.started = true;
    state.jobs.unshift(job); renderJobs(); await loadCredits();
    toast("Generating! You can leave this page — your video will be waiting here.");
    $("history").scrollIntoView({ behavior: "smooth" });
    poll();
  } catch (e) {
    if (e.status === 402) { await loadCredits(); openBuy(e.message); } else toast(e.message, 6000);
  } finally { busy = false; refresh(); }
}

// ---------------- jobs ----------------
async function loadJobs() {
  if (DEMO) state.jobs = demoStore.get().jobs;
  else {
    const { data } = await sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(50);
    state.jobs = data || [];
  }
  renderJobs(); poll();
}
let pollTimer = null, pollErrors = 0;
const GIVE_UP_MS = 45 * 60 * 1000; // stop polling a job this old; it shows "taking longer" instead
const age = (j) => Date.now() - new Date(j.created_at).getTime();
function poll() {
  clearTimeout(pollTimer);
  const open = state.jobs.filter((j) => !TERMINAL.has(j.status) && age(j) < GIVE_UP_MS);
  if (!open.length) return;
  // 5s for the first 3 minutes, then 15s; back off further while the API errors.
  const base = open.some((j) => age(j) < 3 * 60 * 1000) ? 5000 : 15000;
  pollTimer = setTimeout(async () => {
    let changed = false, errored = false;
    for (const j of open) {
      let next = j;
      if (DEMO) {
        if (Date.now() > j.demo_done_at) next = { ...j, status: "completed", output_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" };
        else next = { ...j, status: "in_progress" };
        const d = demoStore.get(); d.jobs = d.jobs.map((x) => (x.id === j.id ? next : x)); demoStore.set(d);
      } else {
        try { next = (await callFn("jobs", { job_id: j.id })).job; } catch { errored = true; }
      }
      if (next.status !== j.status) changed = true;
      Object.assign(j, next);
    }
    pollErrors = errored ? pollErrors + 1 : 0;
    renderJobs();
    if (changed) loadCredits(); // refunds
    poll();
  }, base * Math.min(8, 2 ** pollErrors));
}
const LABEL = { submitting: "Starting", queued: "In queue", in_progress: "Rendering", completed: "Ready",
  failed: "Failed · refunded", nsfw: "Blocked · refunded", canceled: "Canceled · refunded" };
// Cards are keyed by job and only rebuilt when their state changes, so a video being watched keeps playing.
const jobEls = new Map();
const jobKey = (j) => `${j.status}|${j.output_url || ""}|${j.error || ""}|${!TERMINAL.has(j.status) && age(j) >= GIVE_UP_MS}`;
function jobCard(j) {
  const el = document.createElement("div"); el.className = "job";
  const when = new Date(j.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const name = window.TREND_NAMES?.[j.trend] || (j.workflow === "object-swap" ? "Object swap" : "Custom");
  el.innerHTML = `<div class="job-head"><span class="job-meta"></span><span class="status"></span></div>`;
  el.querySelector(".job-meta").textContent = `${name} · ${j.resolution} · ${when}`;
  const st = el.querySelector(".status");
  st.textContent = LABEL[j.status] || "Processing";
  if (LABEL[j.status]) st.classList.add(j.status);
  if (j.status === "completed" && j.output_url) {
    el.insertAdjacentHTML("beforeend", `<video controls playsinline preload="metadata"></video>
      <div class="job-actions"><a class="btn" href="#">Download</a></div>`);
    el.querySelector("video").src = j.output_url;
    const a = el.querySelector("a"); a.href = j.output_url;
    a.onclick = (e) => { e.preventDefault(); download(j.output_url, `genjutsu-${j.trend || "video"}-${j.id.slice(0, 8)}.mp4`, a); };
  } else if (!TERMINAL.has(j.status)) {
    const late = age(j) >= GIVE_UP_MS;
    el.insertAdjacentHTML("beforeend", late
      ? `<div class="job-meta">This is taking longer than usual. Refresh the page later to check again. If it fails, your credits are refunded automatically.</div>`
      : `<div class="progress"><i></i></div><div class="job-meta">Usually takes a few minutes. Safe to refresh or close.</div>`);
  } else if (j.error) {
    const p = document.createElement("p"); p.className = "err"; p.textContent = j.error; el.appendChild(p);
  }
  el._key = jobKey(j);
  return el;
}
function renderJobs() {
  $("history").hidden = !state.jobs.length;
  const box = $("jobs");
  const ids = new Set(state.jobs.map((j) => j.id));
  for (const [id, el] of jobEls) if (!ids.has(id)) { el.remove(); jobEls.delete(id); }
  let prev = null;
  for (const j of state.jobs) {
    let el = jobEls.get(j.id);
    if (el && el._key !== jobKey(j)) { const fresh = jobCard(j); el.replaceWith(fresh); el = fresh; jobEls.set(j.id, el); }
    if (!el) { el = jobCard(j); jobEls.set(j.id, el); }
    const want = prev ? prev.nextSibling : box.firstChild;
    if (want !== el) box.insertBefore(el, want); // only new cards move; existing ones stay put
    prev = el;
  }
}
// Cross-origin files ignore <a download>, so fetch the bytes; if CORS blocks that, open it instead.
async function download(url, name, a) {
  const label = a.textContent; a.textContent = "Downloading…";
  try {
    const r = await fetch(url); if (!r.ok) throw new Error();
    const href = URL.createObjectURL(await r.blob());
    const tmp = Object.assign(document.createElement("a"), { href, download: name });
    document.body.appendChild(tmp); tmp.click(); tmp.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  } catch { location.href = url; } // after an await a new window would be pop-up blocked
  finally { a.textContent = label; }
}

// ---------------- buy credits ----------------
on("credits-pill", "click", () => openBuy());
// "Just this video" pays exactly the missing credits, so nothing is left over. Packs are optional.
const MIN_EXACT = 200; // $2: below that PayPal's fixed fee eats the payment

function packList() {
  const short = estimate() - state.credits;
  if (short <= 0) return C.PACKS;
  const credits = Math.max(short, MIN_EXACT);
  const tag = short >= MIN_EXACT ? "No leftovers" : "Minimum $2";
  return [{ id: "exact", label: "Just this video", tag, credits, usd: (credits / 100).toFixed(2) }, ...C.PACKS];
}
function openBuy(reason) {
  if (estimate() - state.credits > 0) state.pack = "exact";
  else if (state.pack === "exact") state.pack = C.PACKS[0].id;
  $("buy-reason").textContent = reason || "One-time payment. No subscription.";
  $("buy-err").textContent = "";
  renderPacks(); $("buy-modal").showModal(); renderPayPal();
}
on("buy-modal", "close", () => { state.pendingGenerate = false; });
function renderPacks() {
  const box = $("packs"); box.innerHTML = "";
  for (const p of packList()) {
    const b = document.createElement("button");
    b.className = "pack" + (p.id === state.pack ? " active" : "");
    b.innerHTML = `<span><span class="p-name">${p.label}</span>${p.tag ? `<span class="tag">${p.tag}</span>` : ""}
      <div class="p-cred">${p.credits.toLocaleString()} credits</div></span><span class="p-price">$${p.usd}</span>`;
    b.onclick = () => { state.pack = p.id; renderPacks(); renderPayPal(); };
    box.appendChild(b);
  }
}
async function onPaid(creditsAdded) {
  await loadCredits();
  const resume = state.pendingGenerate;
  $("buy-modal").close();
  toast(`+${creditsAdded.toLocaleString()} credits added. Thank you!`);
  refresh();
  if (resume) generate();
}
let ppLoaded = null;
function loadPayPal() {
  return (ppLoaded ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(C.PAYPAL_CLIENT_ID)}&currency=USD&intent=capture&components=buttons`;
    s.onload = res; s.onerror = () => rej(new Error("Could not load PayPal."));
    document.head.appendChild(s);
  }));
}
async function renderPayPal() {
  const box = $("paypal-buttons"); box.innerHTML = "";
  const pack = packList().find((p) => p.id === state.pack) || C.PACKS[0];
  if (DEMO || !C.PAYPAL_CLIENT_ID) {
    const b = document.createElement("button"); b.className = "btn primary wide";
    b.textContent = `Pay $${pack.usd} (demo)`;
    b.onclick = () => { const d = demoStore.get(); d.credits += pack.credits; demoStore.set(d); onPaid(pack.credits); };
    return box.appendChild(b);
  }
  try {
    await loadPayPal();
    await window.paypal.Buttons({
      style: { layout: "vertical", shape: "rect", label: "pay" },
      createOrder: async () => (await callFn("paypal", { action: "create", pack_id: pack.id, credits: pack.credits })).order_id,
      onApprove: async ({ orderID }) => {
        const r = await callFn("paypal", { action: "capture", order_id: orderID });
        if (r?.error) { $("buy-err").textContent = r.error; return; } // pending: credits arrive later
        onPaid(r.credits_added);
      },
      onError: (err) => { $("buy-err").textContent = err?.message || "Payment failed. You were not charged."; },
    }).render(box);
  } catch (e) { $("buy-err").textContent = e.message; }
}

// ---------------- boot ----------------
if (T) {
  $("video-preview").poster = T.poster || "";
  // Preview plays from GitHub Pages; the API gets the storage URL.
  showVideo(T.preview_url || T.video_url, () => { state.video = { url: T.video_url }; });
}
if (HAS_STUDIO) { selectMode(state.mode); selectRes(state.res); renderThumbs(); restoreDraft(); }
refresh();
initAuth();

// Gallery: hover a trend card to play its scene with sound. Browsers block sound until the visitor
// has clicked/tapped the page once, so until then it plays muted and the 🔇 badge turns sound on.
const cards = [...document.querySelectorAll(".trend-card .tc-media")].filter((m) => m.querySelector("video"));
let soundOk = navigator.userActivation?.hasBeenActive ?? false;
const badgeText = (v) => (v.muted ? "🔇 Tap for sound" : "🔊");
function startCard(m) {
  const v = m.querySelector("video"), badge = m.querySelector(".tc-sound");
  m._hover = true;
  cards.forEach((o) => o !== m && stopCard(o));
  if (!v.src) v.src = v.dataset.src;
  const shown = () => { if (!m._hover) return stopCard(m); v.classList.add("on"); badge.hidden = false; badge.textContent = badgeText(v); };
  v.muted = !soundOk;
  v.play().then(shown).catch((e) => {
    if (!m._hover || e.name !== "NotAllowedError") return; // left the card, or play() was interrupted by pause()
    soundOk = false; v.muted = true;
    v.play().then(shown).catch(() => {});
  });
}
function stopCard(m) {
  const v = m.querySelector("video");
  m._hover = false;
  v.pause(); if (v.readyState) v.currentTime = 0;
  v.classList.remove("on"); m.querySelector(".tc-sound").hidden = true;
}
cards.forEach((m) => {
  m.addEventListener("mouseenter", () => startCard(m));
  m.addEventListener("mouseleave", () => stopCard(m));
  m.querySelector(".tc-sound").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); // don't open the trend page
    const v = m.querySelector("video");
    soundOk = true; v.muted = !v.muted; v.play().catch(() => {});
    m.querySelector(".tc-sound").textContent = badgeText(v);
  });
});
// Any click/tap/key on the page unlocks sound; unmute whatever is playing now.
["pointerdown", "keydown"].forEach((ev) => addEventListener(ev, (e) => {
  if (soundOk || e.target.closest?.(".tc-sound")) return; // the badge handles its own click
  soundOk = true;
  cards.filter((m) => m._hover).forEach((m) => { const v = m.querySelector("video"); v.muted = false; m.querySelector(".tc-sound").textContent = badgeText(v); });
}, { capture: true }));
