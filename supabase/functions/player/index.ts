// Emberline leaderboard function. Supabase > Edge Functions > Deploy a new function > Via Editor
// Name it exactly: player
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function sha(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // who is this? Ranked only works with a Puffco login, checked with Puffco's server
    let key = "", verified = false;
    if (typeof body.puffcoToken === "string" && body.puffcoToken) {
      const r = await fetch("https://api.puffco.app/api/users/me", {
        headers: {
          Authorization: "Bearer " + body.puffcoToken, Accept: "application/json",
          Origin: "https://puffco.app", Referer: "https://puffco.app/",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        },
      });
      if (r.ok) {
        const me = await r.json();
        if (!me || !me.id) return json({ error: "puffco_auth", status: 200 }, 401);
        key = "puffco:" + me.id; verified = true;
      } else if (body.puffcoId != null && /^[0-9A-Za-z_-]{1,64}$/.test(String(body.puffcoId))) {
        // Puffco blocks checks from servers: trust the phone, which already checked this login with Puffco directly
        key = "puffco:" + String(body.puffcoId); verified = true;
      } else {
        return json({ error: "puffco_auth", status: r.status }, 401);
      }
    } else return json({ error: "puffco_required" }, 401); // ranked needs a Puffco login
    const id = await sha(key);

    const { data: existing } = await sb.from("players").select("*").eq("id", id).maybeSingle();

    // which Peak / phone this is (sent by the app, used by the dev page and device bans)
    const devs: { serial: string; kind: string; model: string | null; fw: string | null }[] = [];
    const d = body.device && typeof body.device === "object" ? body.device : null;
    if (d) {
      const ok = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9:._-]{4,80}$/.test(v);
      const model = typeof d.model === "string" ? d.model.slice(0, 40) : null, fw = typeof d.fw === "string" ? d.fw.slice(0, 20) : null;
      if (ok(d.serial)) devs.push({ serial: d.serial, kind: "serial", model, fw });
      if (ok(d.ble)) devs.push({ serial: "ble:" + d.ble, kind: "ble", model, fw });
    }
    const saveDevices = async () => {
      if (!devs.length) return;
      const now = new Date().toISOString();
      await sb.from("devices").upsert(devs.map((x) => ({ ...x, player: id, last_seen: now })), { onConflict: "serial,player" });
    };
    // banned account, or a banned Peak / phone
    let banned = !!(existing && existing.banned);
    if (!banned && devs.length) {
      const { data: hit } = await sb.from("banned_devices").select("serial").in("serial", devs.map((x) => x.serial));
      if (hit && hit.length) {
        banned = true;
        if (existing) await sb.from("players").update({ banned: true }).eq("id", id);
      }
    }
    if (banned) {
      if (existing) await saveDevices();
      const { data: last } = await sb.from("bans").select("reason").eq("player", id).eq("action", "ban").order("at", { ascending: false }).limit(1).maybeSingle();
      if (body.action === "me") return json({ player: existing, banned: true, reason: last ? last.reason : "" });
      return json({ error: "banned", reason: last ? last.reason : "" }, 403);
    }
    if (body.action === "me") { if (existing) await saveDevices(); return json({ player: existing }); }


    // Social: follow / unfollow another player (you need a profile first)
    if (body.action === "follow" || body.action === "unfollow") {
      if (!existing) return json({ error: "username_required" }, 400);
      const target = typeof body.target === "string" ? body.target : "";
      if (!/^[0-9a-f]{32}$/.test(target) || target === id) return json({ error: "bad_target" }, 400);
      if (body.action === "follow") {
        const { data: t } = await sb.from("players").select("id").eq("id", target).maybeSingle();
        if (!t) return json({ error: "bad_target" }, 404);
        const { error } = await sb.from("follows").upsert({ follower: id, followee: target });
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await sb.from("follows").delete().eq("follower", id).eq("followee", target);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    const row: Record<string, unknown> = { verified, updated_at: new Date().toISOString() };
    if (typeof body.username === "string") {
      const u = body.username.trim();
      if (!/^[A-Za-z0-9_.]{3,20}$/.test(u)) return json({ error: "username_invalid" }, 400);
      const { data: taken } = await sb.from("players").select("id").ilike("username", u).neq("id", id).maybeSingle();
      if (taken) return json({ error: "username_taken" }, 409);
      const renaming = existing && String(existing.username).toLowerCase() !== u.toLowerCase();
      if (!existing || renaming) {
        // names someone just changed away from stay theirs for 3 days
        const { data: hold } = await sb.from("name_holds").select("player,until").eq("name", u.toLowerCase()).maybeSingle();
        if (hold && hold.player !== id && new Date(hold.until) > new Date()) return json({ error: "username_taken" }, 409);
      }
      if (renaming) {
        // first rename is free, then once every 3 days
        const COOL = 3 * 86400000, last = existing.name_changed_at ? new Date(existing.name_changed_at).getTime() : 0;
        if ((existing.name_changes || 0) >= 1 && Date.now() - last < COOL)
          return json({ error: "name_cooldown", until: new Date(last + COOL).toISOString() }, 429);
        await sb.from("name_holds").upsert({ name: String(existing.username).toLowerCase(), player: id, until: new Date(Date.now() + COOL).toISOString() });
        row.name_changed_at = new Date().toISOString();
        row.name_changes = (existing.name_changes || 0) + 1;
      }
      row.username = u;
    } else if (!existing) return json({ error: "username_required" }, 400);

    if (typeof body.avatar === "string" && body.avatar.startsWith("data:image/jpeg;base64,")) {
      const bytes = Uint8Array.from(atob(body.avatar.split(",")[1]), (c) => c.charCodeAt(0));
      if (bytes.length > 400000) return json({ error: "avatar_too_big" }, 400);
      const path = id + ".jpg";
      const up = await sb.storage.from("avatars").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) return json({ error: "avatar_upload" }, 500);
      row.avatar_url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
    }
    const n = (v: unknown) => Math.max(0, Math.min(100000, Math.round(Number(v))));
    // RP can't crash within the same month (a new phone or computer has no local sessions and would send 0)
    const sameMonth = existing && typeof body.month === "string" && existing.month === body.month;
    // daily limit: going over 1000 RP in one day (UTC) locks you out of ranked for 24h. RP doesn't change while locked
    const DAY_MAX = 1000, LOCK_MS = 86400000, now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
    const lockedUntil = existing && existing.locked_until ? new Date(existing.locked_until).getTime() : 0;
    if (Number.isFinite(Number(body.rp))) {
      const v = n(body.rp), had = sameMonth ? existing.rp || 0 : 0;
      // the app sends base = the leaderboard RP it built on. A drop from that number is the rank tax, so allow more of one
      const maxDrop = Number(body.base) === had ? 100 : 10;
      const dayBase = sameMonth && existing.rp_day === today ? existing.rp_day_base || 0 : had; // RP when today started
      if (sameMonth && v < had - maxDrop) { /* a big drop means a device with no history: keep the server's score (small drops are clean-meter and rank tax penalties) */ }
      else if (sameMonth && lockedUntil > now) { /* locked out of ranked */ }
      else if (sameMonth && v - dayBase > DAY_MAX) { row.locked_until = new Date(now + LOCK_MS).toISOString(); row.rp_day = today; row.rp_day_base = dayBase; }
      else { row.rp = v; row.rp_day = today; row.rp_day_base = dayBase; if (typeof body.tier === "string") row.tier = body.tier.slice(0, 20); }
    } else if (typeof body.tier === "string" && !sameMonth) row.tier = body.tier.slice(0, 20);
    if (Number.isFinite(Number(body.blinkers))) { const v = n(body.blinkers); if (!(sameMonth && v < (existing.blinkers || 0))) row.blinkers = v; }
    if (Array.isArray(body.showcase)) {
      // up to 3 badges: "dev" (only if you have it) or "YYYY-MM:<tier 0-4>" or "YYYY-MM:now"
      const ok = body.showcase.filter((k: unknown) => typeof k === "string" &&
        (k === "dev" ? !!(existing && existing.dev) : /^\d{4}-\d{2}:(?:[0-4]|now)$/.test(k) || /^sp:[a-z0-9]{2,16}$/.test(k)));
      row.showcase = [...new Set(ok)].slice(0, 3);
    }
    if (typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) row.month = body.month;
    if (Array.isArray(body.gear)) {
      // devices you own, shown on your profile: "peak", "peak:<edition>" or "proxy"
      row.gear = [...new Set(body.gear.filter((k: unknown) => typeof k === "string" && /^(peak|proxy)(:[A-Za-z0-9 ]{1,24})?$/.test(k)))].slice(0, 6);
    }
    if (typeof body.bio === "string") row.bio = body.bio.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);

    const q = existing
      ? sb.from("players").update(row).eq("id", id).select().single()
      : sb.from("players").insert({ id, ...row }).select().single();
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    await saveDevices();

    return json({ player: data });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
