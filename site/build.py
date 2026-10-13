#!/usr/bin/env python3
"""Generate the static site in docs/ from site/trends.json.

Add a trend: upload its clip + poster to Supabase storage under inputs/presets/,
add an entry to trends.json, drop a 1200x630 og.jpg in docs/trends/<slug>/
(optional, falls back to the poster), then run:  python3 site/build.py
"""
import html
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DOCS = ROOT / "docs"
DATA = json.loads((SITE / "trends.json").read_text())
BASE = DATA["base_url"]
ALL_TRENDS = DATA["trends"]
# hidden trends (e.g. the 4s QA clip) get a page but stay out of the gallery, links and sitemap
TRENDS = [t for t in ALL_TRENDS if not t.get("hidden")]
TODAY = date.today().isoformat()
CREDITS_PER_SEC_DEFAULT = 15.9  # 480p; keep in sync with docs/config.js
FEE_CREDITS = 100
# Changes whenever app.js / styles.css / config.js change, so browsers never run a stale copy.
ASSET_VER = __import__("hashlib").sha1(b"".join((DOCS / f).read_bytes() for f in ("app.js", "styles.css", "config.js"))).hexdigest()[:10]

esc = html.escape


def abs_url(p):
    """Site-relative asset path (or full URL) -> absolute URL, for meta tags / JSON-LD."""
    return p if p.startswith("http") else BASE + p


def rel(root, p):
    """Site-relative asset path (or full URL) -> URL relative to the current page."""
    return p if p.startswith("http") else root + p


def ld(*objs):
    return "\n".join(
        f'  <script type="application/ld+json">{json.dumps(o, ensure_ascii=False)}</script>' for o in objs
    )


def breadcrumbs(*items):
    return {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": BASE + p} for i, (n, p) in enumerate(items)
        ],
    }


def faq_ld(faq):
    return {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq],
    }


def faq_html(faq):
    return "\n".join(f"      <details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>" for q, a in faq)


def og_image(path, trend=None):
    if trend and (DOCS / "trends" / trend["slug"] / "og.jpg").exists():
        return f"{BASE}trends/{trend['slug']}/og.jpg"
    if trend:
        return abs_url(trend["poster"])
    return f"{BASE}og.jpg"


def head(*, path, title, description, og_title=None, og_type="website", image, extra_ld="", noindex=False):
    root = "../" * path.count("/")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}" />{'\n  <meta name="robots" content="noindex,nofollow" />' if noindex else ''}
  <link rel="canonical" href="{BASE}{path}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Genjutsu Studio" />
  <meta property="og:title" content="{esc(og_title or title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{BASE}{path}" />
  <meta property="og:image" content="{image}" />
  <meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc(og_title or title)}" />
  <meta name="twitter:description" content="{esc(description)}" />
  <meta name="twitter:image" content="{image}" />
  <meta name="theme-color" content="#0b0b10" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌀</text></svg>" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="{root}styles.css?v={ASSET_VER}" />
{extra_ld}
</head>
<body>
  <div id="demo-banner" class="banner" hidden>Demo mode: the backend isn't connected yet, so payments and generation are simulated.</div>
"""


def header(root, app=True, active=""):
    actions = (
        """      <button id="credits-pill" class="pill" hidden><span id="credits-val">0</span> credits <span class="plus">+</span></button>
      <button id="signin-btn" class="btn ghost">Sign in</button>
      <button id="signout-btn" class="btn ghost" hidden>Sign out</button>"""
        if app else f'      <a class="btn primary" href="{root}" style="text-decoration:none">Browse trends</a>'
    )
    cls = lambda k: ' class="active"' if k == active else ""
    return f"""  <header class="top">
    <a class="brand" href="{root}"><span class="logo">🌀</span> Genjutsu<span class="dim">Studio</span></a>
    <nav class="nav"><a href="{root}"{cls('trends')}>Trends</a><a href="{root}custom/"{cls('custom')}>Custom</a><a href="{root}pricing/"{cls('pricing')}>Pricing</a></nav>
    <div class="top-actions">
{actions}
    </div>
  </header>
"""


def footer(root, app=True, page=None):
    trend_links = " · ".join(f'<a href="{root}trends/{t["slug"]}/">{esc(t["short"])}</a>' for t in TRENDS)
    out = f"""  <footer>
    <nav class="foot-links"><a href="{root}">All trends</a> · {trend_links} · <a href="{root}custom/">Custom trend</a> · <a href="{root}pricing/">Pricing</a> · <a href="{root}genjutsu/">Genjutsu without subscription</a></nav>
    Independent service. Powered by the Higgsfield API. Not affiliated with Higgsfield AI or with the owners of the films and clips referenced.
  </footer>
"""
    if not app:
        return out + "</body>\n</html>\n"
    names = {t["slug"]: t["short"] for t in ALL_TRENDS}
    return out + f"""
  <dialog id="signin-modal" class="modal">
    <form method="dialog" class="modal-x"><button aria-label="Close">×</button></form>
    <h3>Sign in</h3>
    <p class="muted">We'll email you a sign-in link. Your credits and videos are saved to your email.</p>
    <div id="signin-step1">
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
      <button id="send-link" class="btn primary wide">Email me a link</button>
    </div>
    <div id="signin-step2" hidden>
      <p>We sent a sign-in link to <b id="sent-to"></b>. Open it on this device, and you'll be signed in automatically.</p>
      <p class="muted">Can't find it? Check your spam folder.</p>
    </div>
    <p class="err" id="signin-err"></p>
  </dialog>

  <dialog id="buy-modal" class="modal">
    <form method="dialog" class="modal-x"><button aria-label="Close">×</button></form>
    <h3>Buy credits</h3>
    <p class="muted" id="buy-reason">One-time payment. No subscription.</p>
    <div class="packs" id="packs"></div>
    <div id="paypal-buttons"></div>
    <p class="err" id="buy-err"></p>
  </dialog>

  <div id="toast" class="toast" hidden></div>

  <script>window.PAGE = {json.dumps(page, ensure_ascii=False)}; window.TREND_NAMES = {json.dumps(names, ensure_ascii=False)};</script>
  <script src="{root}config.js?v={ASSET_VER}"></script>
  <script type="module" src="{root}app.js?v={ASSET_VER}"></script>
</body>
</html>
"""


HISTORY = """    <section id="history" hidden>
      <h2>Your videos</h2>
      <div id="jobs" class="jobs"></div>
    </section>
"""

RES_ROW = """      <div class="row">
        <div class="seg" id="res-seg">
          <button data-res="480p" class="active">480p</button>
          <button data-res="720p">720p</button>
          <button data-res="1080p">1080p</button>
        </div>
        <div class="cost" id="cost">Add a video to see the price</div>
      </div>

      <div class="breakdown" id="breakdown" hidden></div>

      <button id="generate-btn" class="btn primary big" disabled>Generate video</button>
      <p class="fine">Failed or moderated generations are refunded automatically. Results stay available for 7 days, so download them.</p>
"""


def photos_text(t):
    n, m = len(t["slots"]), t.get("min_photos", len(t["slots"]))
    return f"{m}–{n} photos" if m < n else f"{n} photo{'s' if n > 1 else ''}"


def studio_trend(t, root):
    n = len(t["slots"])
    rs = t.get("result_sample")
    result = f"""      <div class="eq-result" id="example">
        <span class="eq-op">=</span>
        <figure class="eq-video">
          <video src="{rel(root, rs['video'])}" poster="{rel(root, rs['poster'])}" muted loop playsinline autoplay preload="metadata"></video>
          <span class="eq-tag">Example result</span>
          <button type="button" class="eq-sound" aria-label="Play with sound"
            onclick="const v=this.previousElementSibling.previousElementSibling;v.muted=!v.muted;v.play();this.textContent=v.muted?'🔇':'🔊'">🔇</button>
        </figure>
      </div>
""" if rs else ""
    return f"""    <section class="card studio" id="studio">
      <div class="preset-bar">
        <span class="trend">🔥 Trending</span>
        <span>The scene is ready. Add {photos_text(t)}, then hit Generate.</span>
      </div>
      <div class="grid2 eq">
        <div class="drop locked" id="video-drop">
          <video id="video-preview" muted loop playsinline autoplay hidden></video>
          <span class="lock-tag">🔒 {esc(t['short'])}</span>
          <button type="button" class="eq-sound" aria-label="Play with sound"
            onclick="const v=document.getElementById('video-preview');v.muted=!v.muted;v.play();this.textContent=v.muted?'🔇':'🔊'">🔇</button>
        </div>
        <span class="eq-op eq-plus">+</span>
        <div class="drop images" id="image-drop">
          <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" hidden />
          <div class="drop-empty" id="image-empty"></div>
          <div class="thumbs" id="thumbs" hidden></div>
        </div>
      </div>
{result}      <ul class="photo-tips">
        <li class="ok">One person per photo</li><li class="ok">Face the camera</li><li class="ok">Good light</li>
        <li class="no">No sunglasses</li><li class="no">No group shots</li>
      </ul>
{RES_ROW}    </section>
"""


STUDIO_CUSTOM = """    <section class="card studio" id="studio">
      <div class="mode-switch" role="tablist">
        <button class="mode active" data-mode="motion-transfer" role="tab">
          <span class="mode-title">Motion transfer</span>
          <span class="mode-sub">Your photos perform the video's motion</span>
        </button>
        <button class="mode" data-mode="object-swap" role="tab">
          <span class="mode-title">Object swap</span>
          <span class="mode-sub">Replace one person or object in the video</span>
        </button>
      </div>

      <div class="grid2">
        <label class="drop" id="video-drop">
          <input type="file" id="video-input" accept="video/mp4" hidden />
          <div class="drop-empty">
            <div class="drop-icon">🎬</div>
            <div class="drop-title">Your video</div>
            <div class="drop-hint">MP4, 4–30 seconds</div>
          </div>
          <video id="video-preview" muted loop playsinline hidden></video>
          <button type="button" class="x" id="video-clear" hidden aria-label="Remove video">×</button>
        </label>

        <div class="drop images" id="image-drop">
          <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
          <div class="drop-empty" id="image-empty">
            <div class="drop-icon">🖼️</div>
            <div class="drop-title">Reference photos</div>
            <div class="drop-hint">JPG / PNG / WEBP, 1–8 photos</div>
          </div>
          <div class="thumbs" id="thumbs" hidden></div>
        </div>
      </div>

      <label class="field">
        <span>Prompt <em>(optional)</em></span>
        <textarea id="prompt" rows="2" maxlength="2000" placeholder="e.g. Replace both characters with the uploaded pictures"></textarea>
      </label>
""" + RES_ROW + """    </section>
"""


def write(rel, content):
    p = DOCS / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    print("wrote", rel)


def price_text(t):
    credits = int(-(-min(30, max(4, -(-t["duration"] // 1))) * CREDITS_PER_SEC_DEFAULT // 1)) + FEE_CREDITS
    return f"{credits:,} credits (≈ ${credits / 100:.2f}) at 480p"


# ---------------- trend pages ----------------
for t in ALL_TRENDS:
    path = f"trends/{t['slug']}/"
    root = "../../"
    s = t["seo"]
    page = {"kind": "trend", "trend": {
        **{k: t[k] for k in ("slug", "short", "video_url", "mode", "resolution", "prompt")},
        "poster": rel(root, t["poster"]),
        "preview_url": rel(root, t.get("preview_url", t["video_url"])),
        "slots": [{**s, "example": rel(root, s["example"]) if s.get("example") else None} for s in t["slots"]],
        "min_photos": t.get("min_photos", len(t["slots"])),
    }}
    howto = {
        "@context": "https://schema.org", "@type": "HowTo", "name": f"How to make the {t['name']} AI video",
        "image": og_image(path, t), "totalTime": "PT5M",
        "step": [{"@type": "HowToStep", "position": i + 1, "name": n, "text": x} for i, (n, x) in enumerate(s["steps"])],
    }
    app_ld = {
        "@context": "https://schema.org", "@type": "WebApplication", "name": f"{t['name']} AI video generator",
        "url": BASE + path, "applicationCategory": "MultimediaApplication", "operatingSystem": "Any (web browser)",
        "description": s["description"], "image": og_image(path, t),
        "offers": {"@type": "AggregateOffer", "priceCurrency": "USD", "lowPrice": "5", "highPrice": "40", "offerCount": "3"},
    }
    steps = "\n".join(f"        <li><b>{esc(n)}.</b> {esc(x)}</li>" for n, x in s["steps"])
    body = head(path=path, title=s["title"], description=s["description"], og_title=s.get("og_title"),
                image=og_image(path, t), noindex=bool(t.get("hidden")),
                extra_ld=ld(app_ld, howto, faq_ld(s["faq"]), breadcrumbs(("Trends", ""), (t["short"], path))))
    body += header(root)
    body += f"""
  <main>
    <div class="crumbs"><a href="{root}">Trends</a> › {esc(t['short'])}</div>
    <section class="hero small">
      <h1>{esc(s['h1'])}</h1>
      <p class="lead">{s['lead']}</p>
      <p class="price-chip">Full scene: {price_text(t)} · no subscription</p>
      {'<p><a class="see-example" href="#example">▶ See an example result</a></p>' if t.get("result_sample") else ''}
    </section>

{studio_trend(t, root)}
{HISTORY}
    <section class="seo">
      <h2>About the trend</h2>
      {s['about_html']}
      <h2>How to make it</h2>
      <ol>
{steps}
      </ol>
    </section>

    <section class="faq">
      <h2>Questions</h2>
{faq_html(s['faq'])}
    </section>

    <section class="more">
      <h2>More trends</h2>
      <p><a href="{root}">Browse all trends</a> or make your own on the <a href="{root}custom/">Custom</a> page.</p>
    </section>
  </main>

"""
    body += footer(root, page=page)
    write(f"{path}index.html", body)

# ---------------- home ----------------
cards = "\n".join(f"""        <a class="trend-card" href="trends/{t['slug']}/">
          <div class="tc-media"><img src="{rel('', t['poster'])}" alt="{esc(t['name'])} AI video trend" loading="lazy" /><video data-src="{rel('', t.get('preview_url', t['video_url']))}" loop playsinline preload="none"></video><span class="tc-badge">🔥 Trending</span><span class="tc-sound" hidden>🔇</span></div>
          <div class="tc-body"><b>{esc(t['name'])}</b><span>{esc(t['card_blurb'])}</span>
            <span class="tc-meta">{photos_text(t)} · {-(-t['duration'] // 1):.0f}s · {price_text(t)}</span></div>
        </a>""" for t in TRENDS)
home_faq = [
    ("What is Genjutsu Studio?", "A site that lets you make viral AI video trends with Higgsfield's Genjutsu model. Pick a trend, add your photos and generate. No subscription."),
    ("How does it work?", "Every trend page has its scene already loaded. You only add a photo for each person. On the Custom page you can upload your own video, up to 8 photos and your own prompt."),
    ("How much does it cost?", "You pay per second of video, with no subscription. At 480p it's about 16 credits per second plus 100 per video (100 credits = $1). Every page shows the exact price before you generate."),
    ("What if the generation fails?", "Your credits are refunded automatically, including when the content is blocked by moderation."),
    ("Can I close the page while it's generating?", "Yes. Your video keeps rendering. Sign in again and you'll find it under \"Your videos\"."),
    ("Do credits expire?", "Credits stay on your account for 12 months."),
]
item_list = {
    "@context": "https://schema.org", "@type": "ItemList", "name": "Genjutsu AI video trends",
    "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": f"{BASE}trends/{t['slug']}/", "name": t["name"]} for i, t in enumerate(TRENDS)],
}
site_ld = {"@context": "https://schema.org", "@type": "WebSite", "name": "Genjutsu Studio", "url": BASE}
home = head(path="", title="Genjutsu AI Video Trends: Put Your Faces in Viral Scenes (No Subscription)",
            description="Make the viral AI video trends with Higgsfield Genjutsu: White Chicks \"A Thousand Miles\" and more. The scene is preloaded, add your photos and generate. No subscription.",
            og_title="Genjutsu AI Video Trends: Your Faces in Viral Scenes", image=f"{BASE}og.jpg",
            extra_ld=ld(site_ld, item_list, faq_ld(home_faq)))
home += header("", active="trends")
home += f"""
  <main>
    <section class="hero">
      <h1>Viral AI video trends, with your faces</h1>
      <p class="lead">Pick a trending scene, add photos of you and your friends, and get the video in minutes.
        Made with <a href="genjutsu/">Higgsfield Genjutsu</a>. No subscription, pay per video.</p>
    </section>

    <section class="trend-grid">
{cards}
        <a class="trend-card custom" href="custom/">
          <div class="tc-media tc-custom"><span>✨</span></div>
          <div class="tc-body"><b>Custom trend</b><span>Upload any video, up to 8 photos and your own prompt.</span>
            <span class="tc-meta">Motion transfer or object swap · 4–30s</span></div>
        </a>
    </section>

{HISTORY}
    <section class="seo">
      <h2>What is a Genjutsu trend?</h2>
      <p>Genjutsu is Higgsfield's video-to-video model, released on August 31, 2026. It keeps the motion, camera move and timing of a clip and recasts the
        people from your photos. That's why it's behind the AI meme remakes going viral on TikTok, Reels and Shorts. Each trend here has its scene already
        loaded, so you only add the photos.</p>
    </section>

    <section class="faq">
      <h2>Questions</h2>
{faq_html(home_faq)}
    </section>
  </main>

"""
home += footer("", page={"kind": "home"})
write("index.html", home)

# ---------------- custom ----------------
custom_faq = [
    ("What can I make on the Custom page?", "Upload any MP4 between 4 and 30 seconds, add 1 to 8 reference photos and, optionally, a prompt. Motion transfer recasts the people in the clip; object swap replaces one person or object."),
    ("What prompt should I write?", "Keep it short and concrete, e.g. \"Replace both characters with the uploaded pictures\" or \"Replace the man in the red shirt with the person in the photo\"."),
    ("How much does it cost?", "You pay per second of the source video (max 30 s). At 480p it's about 16 credits per second plus 100 per video (100 credits = $1). The exact price shows before you generate."),
]
custom = head(path="custom/", title="Custom Genjutsu Video: Upload Any Clip and Photos (No Subscription)",
              description="Make your own AI video trend with Higgsfield Genjutsu: upload a 4–30 second clip, up to 8 photos and your own prompt. Motion transfer or object swap, pay per video.",
              image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(custom_faq), breadcrumbs(("Trends", ""), ("Custom trend", "custom/"))))
custom += header("../", active="custom")
custom += f"""
  <main>
    <div class="crumbs"><a href="../">Trends</a> › Custom trend</div>
    <section class="hero small">
      <h1>Custom trend</h1>
      <p class="lead">Start your own trend: upload any video, add up to 8 photos and tell Genjutsu what to change.</p>
    </section>

{STUDIO_CUSTOM}
{HISTORY}
    <section class="faq">
      <h2>Questions</h2>
{faq_html(custom_faq)}
    </section>
  </main>

"""
custom += footer("../", page={"kind": "custom"})
write("custom/index.html", custom)

# ---------------- genjutsu article ----------------
gfaq = json.loads((SITE / "genjutsu_faq.json").read_text())
g = head(path="genjutsu/", title="Higgsfield Genjutsu Without Subscription: Pay-Per-Video Motion Transfer",
         description="Use Higgsfield Genjutsu (motion transfer and object swap) with no subscription. Limits, price per second, and how to make a video in minutes.",
         og_type="article", image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(gfaq), breadcrumbs(("Trends", ""), ("Higgsfield Genjutsu", "genjutsu/"))))
g += header("../", app=False)
g += f"""  <main>
    <article class="article">
      <div class="crumbs"><a href="../">Trends</a> › Higgsfield Genjutsu</div>
      <h1>Higgsfield Genjutsu, No Subscription</h1>
{(SITE / 'genjutsu_body.html').read_text()}    </article>
  </main>
"""
g += footer("../", app=False)
write("genjutsu/index.html", g)

# ---------------- pricing ----------------
RATES = {"480p": 15.9, "720p": 34.05, "1080p": 81.6}  # credits/sec, keep in sync with docs/config.js


def video_price(secs, res):
    secs = min(30, max(4, -(-secs // 1)))
    return (int(-(-secs * RATES[res] // 1)) + FEE_CREDITS) / 100


pfaq = [
    ("Is there a subscription?", "No. There is no monthly plan and nothing renews. You pay once for the video you are making."),
    ("Do I have to buy credits I won't use?", "No. At checkout, pick \"Just this video\" and you pay exactly that video's price. Packs are optional, for people who plan to make several videos."),
    ("How is the price calculated?", "By the length of the video and the resolution you pick. The exact price shows before you click Generate."),
    ("What if the video fails?", "Failed or moderated generations are refunded automatically to your balance."),
    ("Why do some apps look cheaper?", "Subscription apps advertise \"up to\" numbers based on their cheapest model and shortest clip, and you pay every month whether you use it or not. Here you pay only when you make a video, with Higgsfield Genjutsu, the model that keeps the original scene."),
]
pr = head(path="pricing/", title="Pricing: Pay Per Video, No Subscription | Genjutsu Studio",
          description="Genjutsu Studio pricing: pay once for the video you make. No subscription, no unused credits. Trend videos from about $3.39 at 480p.",
          image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(pfaq), breadcrumbs(("Trends", ""), ("Pricing", "pricing/"))))
pr += header("../", app=False, active="pricing")
pr += f"""  <main>
    <article class="article">
      <div class="crumbs"><a href="../">Trends</a> › Pricing</div>
      <h1>Pay per video. That's it.</h1>
      <p class="lead">No subscription, no monthly credits that expire, no leftovers. You pay for the video you're making, right when you make it.</p>
      <div class="price-points">
        <div><b>🚫 No subscription</b><span>Nothing renews. No plan to cancel.</span></div>
        <div><b>🎯 Pay for just this video</b><span>Checkout charges exactly this video's price.</span></div>
        <div><b>↩️ Failed = refunded</b><span>If it fails or is moderated, you get it back.</span></div>
      </div>

      <h2>How the price is calculated</h2>
      <p>The price depends on how long the video is and the resolution you pick. Here are some examples:</p>
      <table>
        <tr><th>Resolution</th><th>10-second video</th><th>20-second video</th><th>30-second video</th></tr>
""" + "".join(f"        <tr><td>{r}</td>" + "".join(f"<td>${video_price(x, r):.2f}</td>" for x in (10, 20, 30)) + "</tr>\n" for r in RATES) + f"""      </table>
      <p>480p is the default and looks fine on TikTok, Reels and Shorts. The exact price for every trend and for your own clip on the <a href="../custom/">Custom</a> page is shown before you click Generate.</p>

      <h2>Why not a subscription?</h2>
      <p>Most AI video apps sell a monthly plan with a pile of credits. You pay every month, the \"up to 60 videos\" assumes their cheapest model and shortest clip, and unused credits disappear. You usually want one video for one trend, so that's what you pay for here.</p>

      <h2>Optional packs</h2>
      <p>Making a few videos? Packs add a small bonus: $5 = 500 credits, $15 = 1,600 credits (+7%), $40 = 4,500 credits (+12%). 100 credits = $1. You never need one: \"Just this video\" is always an option at checkout.</p>

      <h2>Questions</h2>
{faq_html(pfaq)}
    </article>
  </main>
"""
pr += footer("../", app=False)
write("pricing/index.html", pr)

# ---------------- old URLs → new pages ----------------
REDIRECTS = {"white-chicks-ai-trend/": "trends/white-chicks/", "trends/mafia-daughter/": "trends/storm/"}
for old, new in REDIRECTS.items():
    write(f"{old}index.html", f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Moved</title>
<link rel="canonical" href="{BASE}{new}" /><meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="0; url={BASE}{new}" /></head>
<body><p>This page moved to <a href="{BASE}{new}">{BASE}{new}</a>.</p></body></html>
""")

# ---------------- sitemap / robots ----------------
urls = [("", "1.0"), ("custom/", "0.7"), ("pricing/", "0.8"), ("genjutsu/", "0.7")] + [(f"trends/{t['slug']}/", "0.9") for t in TRENDS]
write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + "".join(f"  <url><loc>{BASE}{u}</loc><lastmod>{TODAY}</lastmod><priority>{p}</priority></url>\n" for u, p in urls)
      + "</urlset>\n")
write("robots.txt", f"User-agent: *\nAllow: /\nSitemap: {BASE}sitemap.xml\n")
