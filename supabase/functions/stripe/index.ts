// Emberline Premium by card. Supabase > Edge Functions > Deploy a new function > Via Editor
// Name it exactly: stripe. Turn OFF "Verify JWT" for it (Stripe can't send a Supabase login).
// Secret it needs (Edge Functions > Secrets): STRIPE_WEBHOOK_SECRET = the whsec_... from the Stripe webhook.
//
// The app opens the Payment Link with ?client_reference_id=<player id>. Stripe calls this function when:
//   checkout.session.completed      -> remember which customer is which player, turn Premium on
//   invoice.paid                    -> every renewal: Premium until the end of the paid month (+2 days grace)
//   customer.subscription.deleted   -> cancelled: Premium stays until the paid month ends, then it's gone
// Premium is the same "premium:YYYY-MM-DD" award the SQL grants use. A plain "premium" (lifetime) is never touched.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

// Stripe-Signature: t=<time>,v1=<hmac>. The hmac is SHA-256 of "<time>.<raw body>" with the webhook secret
async function verified(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"], sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false; // older than 10 minutes: a replay
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return sigs.some((s) => s.length === want.length && s.split("").every((c, i) => c === want[i]));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const raw = await req.text();
  if (!secret || !(await verified(raw, req.headers.get("stripe-signature") || "", secret))) return json({ error: "bad_signature" }, 400);
  const ev = JSON.parse(raw), o = ev.data && ev.data.object || {};
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // which player a Stripe customer is (saved at checkout)
  const playerFor = async (customer: string | null) => {
    if (!customer) return null;
    const { data } = await sb.from("app_kv").select("value").eq("key", "stripe:" + customer).maybeSingle();
    return data && data.value && data.value.player ? String(data.value.player) : null;
  };
  // Premium until this day, unless they already have it longer (or for life)
  const grant = async (player: string, until: string) => {
    const { data: p } = await sb.from("players").select("awards").eq("id", player).maybeSingle();
    if (!p) return false;
    const aw: string[] = Array.isArray(p.awards) ? p.awards : [];
    if (aw.includes("premium")) return true;
    const had = aw.filter((a) => /^premium:\d{4}-\d{2}-\d{2}$/.test(a)).map((a) => a.slice(8)).sort().pop() || "";
    if (had >= until) return true;
    const next = aw.filter((a) => !a.startsWith("premium:")).concat("premium:" + until);
    const { error } = await sb.from("players").update({ awards: next }).eq("id", player);
    return !error;
  };
  const grace = (unix: number) => day(unix + 2 * 86400);

  try {
    if (ev.type === "checkout.session.completed") {
      const player = typeof o.client_reference_id === "string" && /^[0-9a-f]{32}$/.test(o.client_reference_id) ? o.client_reference_id : null;
      if (!player) return json({ ok: true, note: "no player id on this checkout" });
      if (o.customer) await sb.from("app_kv").upsert({ key: "stripe:" + o.customer, value: { player, subscription: o.subscription || null, at: new Date().toISOString() } });
      // the first month: the invoice usually lands too, but don't wait for it
      await grant(player, grace(Math.floor(Date.now() / 1000) + 31 * 86400));
      return json({ ok: true });
    }
    if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") {
      const player = await playerFor(o.customer);
      if (!player) return json({ ok: true, note: "unknown customer" });
      const ends = (o.lines && o.lines.data || []).map((l: { period?: { end?: number } }) => l.period && l.period.end || 0);
      const end = Math.max(o.period_end || 0, ...ends);
      await grant(player, grace(end || Math.floor(Date.now() / 1000) + 31 * 86400));
      return json({ ok: true });
    }
    if (ev.type === "customer.subscription.deleted") {
      // nothing to take away now: the award already ends when the paid month does
      return json({ ok: true });
    }
    return json({ ok: true, ignored: ev.type });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
