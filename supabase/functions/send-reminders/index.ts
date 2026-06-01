// =============================================================
// send-reminders — invoked every minute by pg_cron.
// Reads today's goals from app_state, and for each timed goal
// fires a Web Push ~LEAD_MINUTES before timeStart and again at
// timeEnd. Dedup via reminder_log so it never double-sends.
// Deploy:  supabase functions deploy send-reminders --no-verify-jwt
// Secrets: VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT
//          (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected)
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const LEAD_MINUTES = 10;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---- time helpers -------------------------------------------------
// Offset (ms) such that local = utc + offset, for an IANA tz at `date`.
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// UTC instant (ms) for a local wall-clock y-m-d h:mi in tz.
function localWallToInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = guess - tzOffsetMs(new Date(guess), tz);
  inst = guess - tzOffsetMs(new Date(inst), tz); // refine across DST edges
  return inst;
}

// Local date parts of `now` in tz.
function localParts(now: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(now)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day };
}

function dateStr(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function addDays(s: string, n: number): string {
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function parseHM(t: string): { h: number; mi: number } | null {
  if (!t || typeof t !== "string") return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { h: +m[1], mi: +m[2] };
}
function fmt12(t: string): string {
  const hm = parseHM(t);
  if (!hm) return t;
  const ampm = hm.h >= 12 ? "PM" : "AM";
  const h = hm.h % 12 || 12;
  return `${h}:${String(hm.mi).padStart(2, "0")} ${ampm}`;
}
function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

type Goal = { text?: string; done?: boolean; timeStart?: string; timeEnd?: string; time?: string };
type Trigger = { kind: "pre" | "end"; instant: number; keyDate: string; goal: Goal };

// Build the trigger instants for one goals-day key, in tz.
function triggersForDay(keyDate: string, goals: Goal[], tz: string): Trigger[] {
  const out: Trigger[] = [];
  const [y, mo, d] = keyDate.split("-").map(Number);
  for (const g of goals || []) {
    if (!g || g.done) continue;
    const start = g.timeStart || g.time;
    const end = g.timeEnd;
    if (start) {
      const hm = parseHM(start);
      if (hm) {
        // start minus lead, rolling back across midnight if needed
        let total = hm.h * 60 + hm.mi - LEAD_MINUTES;
        let dd = keyDate;
        if (total < 0) { total += 1440; dd = addDays(keyDate, -1); }
        const [yy, mm, ddn] = dd.split("-").map(Number);
        const inst = localWallToInstant(yy, mm, ddn, Math.floor(total / 60), total % 60, tz);
        out.push({ kind: "pre", instant: inst, keyDate, goal: g });
      }
    }
    if (end) {
      const hm = parseHM(end);
      if (hm) {
        const inst = localWallToInstant(y, mo, d, hm.h, hm.mi, tz);
        out.push({ kind: "end", instant: inst, keyDate, goal: g });
      }
    }
  }
  return out;
}

async function claim(reminderKey: string): Promise<boolean> {
  const { error } = await db.from("reminder_log").insert({ reminder_key: reminderKey });
  if (!error) return true;
  if (error.code === "23505") return false; // already sent
  console.error("reminder_log insert error:", error);
  return false;
}

async function sendToAll(subs: any[], payload: object) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
    } catch (e: any) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else {
        console.error("push error:", code, e && e.body);
      }
    }
  }));
}

Deno.serve(async () => {
  const now = new Date();
  const nowMs = now.getTime();

  // Goals (single shared row, appKey 'goals').
  const { data: goalsRow, error: gErr } = await db
    .from("app_state").select("data").eq("key", "goals").maybeSingle();
  if (gErr) return json({ ok: false, error: gErr.message }, 500);
  const goalsData: Record<string, Goal[]> = (goalsRow && goalsRow.data) || {};

  // Subscriptions (grouped by timezone).
  const { data: subs, error: sErr } = await db.from("push_subscriptions").select("*");
  if (sErr) return json({ ok: false, error: sErr.message }, 500);
  if (!subs || subs.length === 0) return json({ ok: true, sent: 0, note: "no subscriptions" });

  const byTz = new Map<string, any[]>();
  for (const s of subs) {
    const tz = s.timezone || "UTC";
    if (!byTz.has(tz)) byTz.set(tz, []);
    byTz.get(tz)!.push(s);
  }

  let sent = 0;

  for (const [tz, tzSubs] of byTz) {
    const lp = localParts(now, tz);
    const todayStr = dateStr(lp.y, lp.mo, lp.d);
    const candidateDays = [addDays(todayStr, -1), todayStr]; // catch post-midnight ends + pre-start rollbacks

    for (const keyDate of candidateDays) {
      const list = goalsData["goals:" + keyDate];
      if (!Array.isArray(list)) continue;

      for (const trig of triggersForDay(keyDate, list, tz)) {
        const delta = nowMs - trig.instant;
        // Fire within the matching minute; tolerate a slightly late/skipped cron tick.
        if (delta < -5000 || delta > 120000) continue;

        const text = (trig.goal.text || "Goal").trim();
        const reminderKey = `${tz}|${trig.keyDate}|${trig.kind}|${slug(text)}`;
        if (!(await claim(reminderKey))) continue;

        const start = trig.goal.timeStart || trig.goal.time;
        const end = trig.goal.timeEnd;
        const rangeLabel = start && end ? `${fmt12(start)} – ${fmt12(end)}` : start ? fmt12(start) : end ? fmt12(end) : "";

        const payload = trig.kind === "pre"
          ? { title: "⏰ Coming up", body: `${text}${rangeLabel ? " · " + rangeLabel : ""} (in ${LEAD_MINUTES} min)`, url: "./index.html", tag: reminderKey }
          : { title: "✓ Wrap up", body: `${text}${end ? " · ends " + fmt12(end) : ""}`, url: "./index.html", tag: reminderKey };

        await sendToAll(tzSubs, payload);
        sent++;
      }
    }
  }

  return json({ ok: true, sent });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}
