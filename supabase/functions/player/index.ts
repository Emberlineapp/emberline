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

    // ---- phone alerts (web push). The keys are made here the first time and kept in app_kv, so there's nothing to set up ----
    // loaded only when needed, so if it ever fails only alerts break (ranked, profiles and follows keep working)
    // deno-lint-ignore no-explicit-any
    const wp = async (): Promise<any> => (await import("npm:web-push@3.6.7")).default;
    const vapid = async () => {
      const { data } = await sb.from("app_kv").select("value").eq("key", "vapid").maybeSingle();
      if (data && data.value && data.value.publicKey) return data.value as { publicKey: string; privateKey: string };
      const k = (await wp()).generateVAPIDKeys(); await sb.from("app_kv").upsert({ key: "vapid", value: k }); return k;
    };
    const pushTo = async (subs: { endpoint: string; sub: unknown }[], payload: Record<string, unknown>) => {
      if (!subs.length) return 0;
      try {
        const webpush = await wp(), k = await vapid(); webpush.setVapidDetails("https://emberlineapp.github.io/emberline/", k.publicKey, k.privateKey);
        let n = 0;
        for (const s of subs) {
          try { await webpush.sendNotification(s.sub as any, JSON.stringify(payload), { TTL: 900, urgency: "high" }); n++; }
          catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint); } // that phone turned alerts off
        }
        return n;
      } catch (_) { return 0; } // push is extra: a failure never breaks the invite or follow
    };
    const pushPlayer = async (player: string, payload: Record<string, unknown>) => {
      const { data: subs } = await sb.from("push_subs").select("endpoint,sub").eq("player", player).limit(5);
      return pushTo(subs || [], payload);
    };
    // the Alerts app (Safari, Home Screen) has no Puffco login: it gets the key, then pairs with a 6-character code from Emberline
    if (body.action === "push_key") return json({ key: (await vapid()).publicKey });

    // Limited Edition Testing (limited.html): an owner of a special edition shared its lights. Bug Hunter for that username, once per shared device
    if (body.action === "edition_claim") {
      const WANTED = ["Opal", "Indiglow", "Guardian", "Desert", "Flourish", "Storm", "Daybreak", "Plasma", "Glacier", "Haze", "Pine"]; // keep in step with limited.html
      const hash = String(body.hash || ""), name = String(body.username || "").trim();
      if (!/^[0-9a-f]{64}$/.test(hash) || !name || name.length > 32) return json({ error: "bad_request" }, 400);
      const { data: row } = await sb.from("edition_lights").select("edition, files").eq("hash", hash).maybeSingle();
      if (!row || !(WANTED.includes(row.edition) || /^Proxy \d+$/.test(row.edition))) return json({ error: "not_wanted" }, 404); // "Proxy <code>": a Proxy edition we don't know yet
      const nf = row.files && typeof row.files === "object" ? Object.keys(row.files).filter((k) => /\/colr$/.test(k)).length : 0;
      if (nf < 5) return json({ error: "not_wanted" }, 404); // a real Peak Pro has all six light slots
      const key = "edclaim:" + hash;
      const { data: used } = await sb.from("app_kv").select("value").eq("key", key).maybeSingle();
      if (used) return json({ error: "already_claimed", username: (used.value as { username?: string })?.username }, 409);
      const { data: p } = await sb.from("players").select("id, username, awards").ilike("username", name.replace(/[\\%_]/g, "\\$&")).maybeSingle();
      if (!p) return json({ error: "no_player" }, 404);
      const aw: string[] = Array.isArray(p.awards) ? p.awards as string[] : [], had = aw.includes("bughunter");
      if (!had) { const { error } = await sb.from("players").update({ awards: [...aw, "bughunter"] }).eq("id", p.id); if (error) throw error; }
      await sb.from("app_kv").upsert({ key, value: { username: p.username, edition: row.edition, at: new Date().toISOString() } });
      return json({ ok: true, username: p.username, had });
    }
    if (body.action === "push_pair") {
      const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), sub = body.sub;
      if (code.length !== 6 || !sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return json({ error: "bad_code" }, 400);
      const { data: link } = await sb.from("push_links").select("player,until").eq("code", code).maybeSingle();
      if (!link || new Date(link.until).getTime() < Date.now()) return json({ error: "bad_code" }, 400);
      await sb.from("push_subs").upsert({ endpoint: sub.endpoint, player: link.player, sub });
      await sb.from("push_links").delete().eq("code", code);
      const { data: p } = await sb.from("players").select("username").eq("id", link.player).maybeSingle();
      await pushTo([{ endpoint: sub.endpoint, sub }], { title: "Emberline alerts are on 🔥", body: "1v1 invites and new followers will show up here." });
      return json({ ok: true, username: p ? p.username : null });
    }
    if (body.action === "push_test") {
      const ep = typeof body.endpoint === "string" ? body.endpoint : "";
      const { data: s } = await sb.from("push_subs").select("endpoint,sub").eq("endpoint", ep).maybeSingle();
      if (!s) return json({ error: "not_paired" }, 404);
      return json({ ok: true, sent: await pushTo([s], { title: "Test from Emberline", body: "Phone alerts work. 🔥" }) });
    }

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
    // Squad Up badge: friends who joined from your invite link. A friend counts once they've done 3 sessions,
    // isn't banned and doesn't share a Peak or phone with you. 3 friends puts "squad" in your awards for good
    const INVITES_NEEDED = 3;
    const invites = async () => {
      const { data: kids } = await sb.from("players").select("id,stats,banned").eq("referred_by", id).limit(200);
      if (!kids || !kids.length) return { done: 0, joined: 0 };
      const { data: mine } = await sb.from("devices").select("serial").eq("player", id);
      const ser = new Set((mine || []).map((x: { serial: string }) => x.serial));
      const { data: theirs } = await sb.from("devices").select("player,serial").in("player", kids.map((k: { id: string }) => k.id));
      const shared = new Set((theirs || []).filter((x: { serial: string }) => ser.has(x.serial)).map((x: { player: string }) => x.player));
      const real = kids.filter((k: { id: string; banned: boolean }) => !k.banned && !shared.has(k.id));
      return { done: real.filter((k: { stats: { sessions?: number } | null }) => Number(k.stats && k.stats.sessions) >= 3).length, joined: real.length };
    };
    const withInvites = async (p: Record<string, unknown> | null) => {
      if (!p) return p;
      const inv = await invites(), aw: string[] = Array.isArray(p.awards) ? p.awards as string[] : [];
      if (inv.done >= INVITES_NEEDED && !aw.includes("squad")) {
        const next = [...aw, "squad"]; await sb.from("players").update({ awards: next }).eq("id", id); p.awards = next;
      }
      return { ...p, invites: inv.done, invites_joined: inv.joined };
    };

    if (body.action === "me") { if (existing) await saveDevices(); return json({ player: await withInvites(existing) }); }

    // ---- notifications: an inbox in the app, plus a push to the phone when Alerts are on ----
    const notify = async (player: string, kind: string, data: Record<string, unknown>, title: string, text: string) => {
      await sb.from("notes").insert({ player, kind, from_id: id, from_name: existing ? existing.username : null, data });
      return pushPlayer(player, { title, body: text, kind, data: { ...data, from: id, n: existing ? existing.username : null } });
    };
    if (body.action === "notes") {
      const { data: list } = await sb.from("notes").select("id,kind,from_id,from_name,data,read,created_at").eq("player", id).order("created_at", { ascending: false }).limit(30);
      const unread = (list || []).filter((x: { read: boolean }) => !x.read).length;
      if (body.read && unread) await sb.from("notes").update({ read: true }).eq("player", id).eq("read", false);
      const { count } = await sb.from("push_subs").select("endpoint", { count: "exact", head: true }).eq("player", id);
      return json({ notes: list || [], unread, phones: count || 0 });
    }
    if (body.action === "push_link") {
      if (!existing) return json({ error: "username_required" }, 400);
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(6));
      const code = Array.from(r, (b) => A[b % A.length]).join("");
      await sb.from("push_links").delete().eq("player", id);
      await sb.from("push_links").insert({ code, player: id, until: new Date(Date.now() + 15 * 60000).toISOString() });
      return json({ code });
    }
    // straight from the app, when the browser itself can do push (Path, Chrome): no code needed
    if (body.action === "push_sub") {
      const sub = body.sub;
      if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return json({ error: "bad_sub" }, 400);
      await sb.from("push_subs").upsert({ endpoint: sub.endpoint, player: id, sub });
      return json({ ok: true, sent: await pushTo([{ endpoint: sub.endpoint, sub }], { title: "Emberline notifications are on 🔥", body: "1v1 invites and new followers will show up here." }) });
    }
    if (body.action === "push_off") { await sb.from("push_subs").delete().eq("player", id); return json({ ok: true }); }
    if (body.action === "push_me") return json({ ok: true, sent: await pushPlayer(id, { title: "Test from Emberline", body: "Phone alerts work. 🔥" }) });
    // a 1v1 invite to a friend (you follow each other). The live invite still goes over the lobby; this reaches them when the app is closed
    if (body.action === "invite") {
      if (!existing) return json({ error: "username_required" }, 400);
      const target = typeof body.target === "string" ? body.target : "", code = String(body.code || "").toUpperCase();
      if (!/^[0-9a-f]{32}$/.test(target) || target === id || !/^[A-Z0-9]{6}$/.test(code)) return json({ error: "bad_target" }, 400);
      const [{ data: a }, { data: b }] = await Promise.all([
        sb.from("follows").select("follower").eq("follower", id).eq("followee", target).maybeSingle(),
        sb.from("follows").select("follower").eq("follower", target).eq("followee", id).maybeSingle()]);
      if (!a || !b) return json({ error: "not_friends" }, 403);
      const { data: last } = await sb.from("notes").select("created_at").eq("player", target).eq("from_id", id).eq("kind", "invite").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - new Date(last.created_at).getTime() < 30000) return json({ ok: true, skipped: true }); // no spamming
      if (body.kind === "sesh") { // group sesh: same invite, different words
        const sent = await notify(target, "invite", { code, sesh: true }, `🔥 ${existing.username} started a group sesh`, "Open Emberline to heat up together");
        return json({ ok: true, pushed: sent });
      }
      const bet = Math.max(0, Math.min(100, Math.round(Number(body.bet) || 0)));
      const sent = await notify(target, "invite", { code, bet, rules: body.rules && typeof body.rules === "object" ? body.rules : null }, `🔥 ${existing.username} wants to 1v1`, bet ? `Bet: ${bet} RP. Open Emberline to accept` : "Open Emberline to accept");
      return json({ ok: true, pushed: sent });
    }


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
        // tell them (once a day per follower, so follow / unfollow / follow doesn't spam)
        const { data: last } = await sb.from("notes").select("created_at").eq("player", target).eq("from_id", id).eq("kind", "follow").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (!last || Date.now() - new Date(last.created_at).getTime() > 86400000) {
          const notify1 = async () => { await sb.from("notes").insert({ player: target, kind: "follow", from_id: id, from_name: existing.username, data: {} });
            await pushPlayer(target, { title: `${existing.username} followed you`, body: "Tap to see their profile in Emberline", kind: "follow", data: { from: id, n: existing.username } }); };
          await notify1();
        }
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
      if (bytes.length > 60000) return json({ error: "avatar_too_big" }, 400); // the app sends 160px pictures (about 10 KB)
      const path = id + ".jpg";
      const up = await sb.storage.from("avatars").upload(path, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" }) // phones keep it a year (the URL changes with ?v= on every new picture), so it isn't downloaded again;
      if (up.error) return json({ error: "avatar_upload" }, 500);
      row.avatar_url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
    }
    const tierFor = (rp: number) => rp >= 5000 ? "Legend" : rp >= 500 ? "Champion" : rp >= 300 ? "Inferno" : rp >= 150 ? "Blaze" : rp >= 50 ? "Flame" : "Ember";
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
      else if (v - dayBase > DAY_MAX) { row.locked_until = new Date(now + LOCK_MS).toISOString(); row.rp_day = today; row.rp_day_base = dayBase; } // every push, including a new account's first one and the first of a month
      else { row.rp = v; row.rp_day = today; row.rp_day_base = dayBase; row.tier = tierFor(v); } // tier comes from the RP we accepted, not from the app
    } else if (!existing || (typeof body.month === "string" && existing.month !== body.month)) row.tier = tierFor(0); // a new month only. A save with no month (picture, bio) must not reset the tier
    if (Number.isFinite(Number(body.blinkers))) { const v = n(body.blinkers); if (!(sameMonth && v < (existing.blinkers || 0))) row.blinkers = v; }
    // badges only the dev hands out (players.awards), and Founder (joined in October 2026), can't be claimed by the app
    const awards: string[] = existing && Array.isArray(existing.awards) ? existing.awards : [];
    // Premium: "premium" (no end) or "premium:YYYY-MM-DD" (through that day)
    const premium = awards.some((a) => a === "premium" || (/^premium:\d{4}-\d{2}-\d{2}$/.test(a) && a.slice(8) >= new Date().toISOString().slice(0, 10)));
    const joined = existing && existing.created_at ? new Date(existing.created_at).getTime() : Date.now();
    const handedOut = (k: string) => {
      if (k === "sp:premium") return premium;
      if (["sp:bughunter", "sp:discord", "sp:podium", "sp:squad"].includes(k)) return awards.includes(k.slice(3));
      if (k === "sp:founder") return joined < Date.parse("2026-11-01T00:00:00Z");
      return true;
    };
    if (Array.isArray(body.showcase)) {
      // up to 3 badges: "dev" (only if you have it) or "YYYY-MM:<tier 0-5>" or "YYYY-MM:now"
      const ok = body.showcase.filter((k: unknown) => typeof k === "string" &&
        (k === "dev" ? !!(existing && existing.dev) : /^\d{4}-\d{2}:(?:[0-5]|now)$/.test(k) || /^sp:[a-z0-9]{2,16}$/.test(k)) && handedOut(k));
      row.showcase = [...new Set(ok)].slice(0, 3);
    }
    if (typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) row.month = body.month;
    if (Array.isArray(body.gear)) {
      // devices you own, shown on your profile: "peak", "peak:<edition>" or "proxy"
      row.gear = [...new Set(body.gear.filter((k: unknown) => typeof k === "string" && /^(peak|proxy)(:[A-Za-z0-9 ]{1,24})?$/.test(k)))].slice(0, 6);
    }
    // invite link: who sent you. Only when the profile is new (or under 7 days old) and nobody is set yet
    if (typeof body.ref === "string" && /^[A-Za-z0-9_.]{3,32}$/.test(body.ref) && (!existing || (!existing.referred_by && Date.now() - joined < 7 * 86400000))) {
      const r = body.ref;
      const { data: who } = /^[0-9a-f]{32}$/.test(r)
        ? await sb.from("players").select("id,referred_by").eq("id", r).maybeSingle()
        : await sb.from("players").select("id,referred_by").ilike("username", r.replace(/[_%\\]/g, "\\$&")).maybeSingle(); // _ is a wildcard in ilike
      if (who && who.id !== id && who.referred_by !== id) row.referred_by = who.id; // not yourself, and no inviting each other
    }
    // Premium (awards has "premium", added by hand after a Discord ticket): a profile banner from the app's list
    if (typeof body.banner === "string" && /^[a-z]{2,12}$/.test(body.banner) && premium) row.banner = body.banner;
    // or their own picture (the app crops it to 720x220, about 40 KB). Kept next to the profile pictures
    // a GIF comes as it is (up to 1.5 MB) so it keeps moving
    const bm = typeof body.bannerImg === "string" ? /^data:image\/(jpeg|gif);base64,/.exec(body.bannerImg) : null;
    if (bm && premium) {
      const gif = bm[1] === "gif", bytes = Uint8Array.from(atob(body.bannerImg.split(",")[1]), (c) => c.charCodeAt(0));
      if (bytes.length > (gif ? 1600000 : 150000)) return json({ error: "banner_too_big" }, 400);
      if (gif && !(bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) return json({ error: "banner_not_gif" }, 400); // starts with "GIF"
      const path = id + "-banner." + (gif ? "gif" : "jpg");
      const up = await sb.storage.from("avatars").upload(path, bytes, { contentType: gif ? "image/gif" : "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (up.error) return json({ error: "banner_upload" }, 500);
      row.banner = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
    }
    if (typeof body.bio === "string") row.bio = body.bio.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
    if (body.stats && typeof body.stats === "object") {
      // profile stats from the app (tap a name to see them): only these numbers, kept in a sane range
      const st: Record<string, number> = {};
      for (const k of ["sessions", "hits", "days", "blAll", "dw", "dl", "dd"]) { const v = Number(body.stats[k]); if (Number.isFinite(v)) st[k] = Math.max(0, Math.min(100000, Math.round(v))); } // dw/dl/dd: 1v1 wins, losses, draws (all time)
      { const v = Number(body.stats.best); if (Number.isFinite(v)) st.best = Math.max(0, Math.min(120, Math.round(v * 10) / 10)); }
      // several devices on one account: never let a phone or tablet with less history lower the numbers.
      // All-time blinkers always keep the highest; this month's numbers keep the highest within the same month
      const old = existing && existing.stats && typeof existing.stats === "object" ? existing.stats : {};
      for (const k of ["blAll", "dw", "dl", "dd"]) if (Number(old[k]) > (st[k] ?? 0)) st[k] = Number(old[k]);
      if (sameMonth) for (const k of ["sessions", "hits", "days", "best"]) if (Number(old[k]) > (st[k] ?? 0)) st[k] = Number(old[k]);
      row.stats = st;
    }

    const q = existing
      ? sb.from("players").update(row).eq("id", id).select().single()
      : sb.from("players").insert({ id, ...row }).select().single();
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    await saveDevices();

    return json({ player: await withInvites(data) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
