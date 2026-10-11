// POST {action:"create", pack_id} -> {order_id}
// POST {action:"capture", order_id} -> {credits_added, balance}
import { admin, getUser, json, serve } from "../_shared/common.ts";

// Keep in sync with PACKS in docs/config.js (server is authoritative).
const PACKS: Record<string, { usd: string; credits: number }> = {
  starter: { usd: "5.00", credits: 500 },
  creator: { usd: "15.00", credits: 1600 },
  studio: { usd: "40.00", credits: 4500 },
};

const PP_BASE = Deno.env.get("PAYPAL_ENV") === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function ppToken(): Promise<string> {
  const basic = btoa(`${Deno.env.get("PAYPAL_CLIENT_ID")}:${Deno.env.get("PAYPAL_CLIENT_SECRET")}`);
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`PayPal auth failed: ${r.status}`);
  return (await r.json()).access_token;
}

serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);

  try {
    const body = await req.json();
    const token = await ppToken();
    const pp = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    if (body.action === "create") {
      // "exact" = pay for just the credits missing for one video (1 credit = $0.01), no leftovers.
      const n = Math.floor(Number(body.credits));
      const pack = body.pack_id === "exact"
        ? (n >= 50 && n <= 5000 ? { usd: (n / 100).toFixed(2), credits: n } : null)
        : PACKS[body.pack_id];
      if (!pack) return json({ error: "Unknown pack" }, 400);
      const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: { ...pp, "PayPal-Request-Id": crypto.randomUUID() },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            amount: { currency_code: "USD", value: pack.usd },
            description: `Genjutsu Studio — ${pack.credits} credits`,
            custom_id: user.id,
          }],
          application_context: { shipping_preference: "NO_SHIPPING", brand_name: "Genjutsu Studio" },
        }),
      });
      const order = await r.json();
      if (!r.ok) return json({ error: "Could not create PayPal order", detail: order }, 502);
      await admin.from("payments").insert({
        order_id: order.id, user_id: user.id, pack_id: body.pack_id, usd: pack.usd, credits: pack.credits,
      });
      return json({ order_id: order.id });
    }

    if (body.action === "capture") {
      const { data: pay } = await admin.from("payments").select("*")
        .eq("order_id", body.order_id).eq("user_id", user.id).maybeSingle();
      if (!pay) return json({ error: "Unknown order" }, 404);

      if (pay.status !== "completed") {
        const r = await fetch(`${PP_BASE}/v2/checkout/orders/${pay.order_id}/capture`, {
          method: "POST", headers: { ...pp, "PayPal-Request-Id": `cap-${pay.order_id}` },
        });
        const cap = await r.json();
        const already = cap?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED";
        const unit = cap?.purchase_units?.[0]?.payments?.captures?.[0];
        const paidOk = unit?.status === "COMPLETED" &&
          unit.amount?.currency_code === "USD" && Number(unit.amount.value) === Number(pay.usd);
        if (!paidOk && !already) return json({ error: "Payment was not completed", detail: cap }, 402);
        await admin.rpc("complete_payment", { p_order_id: pay.order_id });
      }
      const { data: prof } = await admin.from("profiles").select("credits").eq("user_id", user.id).single();
      return json({ credits_added: pay.credits, balance: prof?.credits ?? 0 });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
