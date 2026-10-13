// PayPal webhook: PAYMENT.CAPTURE.REFUNDED / PAYMENT.CAPTURE.REVERSED take the credits back.
// Every event is verified with PayPal (verify-webhook-signature) before we act on it.
import { admin, json, serve } from "../_shared/common.ts";
import { PP_BASE, ppToken } from "../_shared/paypal.ts";

serve(async (req) => {
  const raw = await req.text();
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "bad payload" }, 400); }

  const token = await ppToken();
  const pp = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const h = (k: string) => req.headers.get(k) ?? "";
  const v = await fetch(`${PP_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST", headers: pp,
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"),
      webhook_id: Deno.env.get("PAYPAL_WEBHOOK_ID"), webhook_event: event,
    }),
  }).then((r) => r.json()).catch(() => null);
  if (v?.verification_status !== "SUCCESS") return json({ error: "unverified" }, 401);

  const type = String(event.event_type);
  if (type !== "PAYMENT.CAPTURE.REFUNDED" && type !== "PAYMENT.CAPTURE.REVERSED") return json({ ok: true });

  // Find the capture: a reversal's resource is the capture itself; a refund links "up" to it.
  const res = event.resource ?? {};
  const captureId = type === "PAYMENT.CAPTURE.REVERSED"
    ? res.id
    : String((res.links ?? []).find((l: { rel: string }) => l.rel === "up")?.href ?? "").split("/").pop();
  if (!captureId) return json({ error: "no capture" }, 400);
  const cap = await fetch(`${PP_BASE}/v2/payments/captures/${captureId}`, { headers: pp }).then((r) => r.json());
  const orderId = cap?.supplementary_data?.related_ids?.order_id;
  const { data: pay } = await admin.from("payments").select("*").eq("order_id", orderId).maybeSingle();
  if (!pay) return json({ ok: true, note: "unknown order" });

  // How many of this order's credits should be gone now (cumulative, so retries are idempotent).
  let target = pay.credits;
  if (type === "PAYMENT.CAPTURE.REFUNDED") {
    const refunded = Number(res.seller_payable_breakdown?.total_refunded_amount?.value ?? res.amount?.value ?? 0);
    target = Math.min(pay.credits, Math.round((refunded / Number(pay.usd)) * pay.credits));
  }
  const { data: taken } = await admin.rpc("claw_payment", { p_order_id: pay.order_id, p_target: target });
  console.log("paypal clawback", type, pay.order_id, "credits removed:", taken);
  return json({ ok: true });
});
