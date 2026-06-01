# Goal-reminder push notifications — setup

This adds iOS/Android/desktop push reminders for timed goals. A reminder fires
**~10 minutes before** a goal's start time and again **at its end time**, even
when the app is closed.

iOS only delivers Web Push to a **Home-Screen PWA on iOS 16.4+**. You must add
the site to your Home Screen and open it from that icon.

## What's already in the repo
- `manifest.json`, `sw.js`, `notifications.js`, app icons — the PWA front end.
- The **VAPID public key** is embedded in `notifications.js` (public = safe to ship).
- `supabase/push_setup.sql` — tables, RLS, and the every-minute cron.
- `supabase/functions/send-reminders/index.ts` — the scheduler.

## One-time setup

### 1. Create the tables + cron
Open `supabase/push_setup.sql`, replace `<PROJECT_REF>` and
`<ANON_OR_SERVICE_KEY>` in the cron block, then run the whole file in the
Supabase SQL editor. (`<PROJECT_REF>` is `jxjjudnveewaledvuhpi`.)

### 2. Set the Edge Function secrets
Use the VAPID keys generated for this project. The **private key is secret** —
do not commit it.

```
supabase secrets set \
  VAPID_PUBLIC=BM5KaQR8xF3SNR4sqq3G3HMBHfgS50bfXHR0xhy3UwzrINB2Lb08MxRqMI6CgpFL6XDlJ0s27_FfPm0Dl7tWPts \
  VAPID_PRIVATE=<VAPID_PRIVATE_KEY> \
  VAPID_SUBJECT=mailto:mansourmmohamed709@gmail.com
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

### 3. Deploy the function
```
supabase functions deploy send-reminders --no-verify-jwt
```
`--no-verify-jwt` lets the cron call it with the anon/service bearer token.

### 4. On your iPhone
Because the app was already on your Home Screen **before** push existed, iOS
locked in the old (no-push) capability. So:
1. Delete the existing Home-Screen icon.
2. Open the site in Safari → Share → **Add to Home Screen**.
3. Open the app from the new icon.
4. In the To Do List section, tap **Enable reminders** → Allow.

## Test it
- Desktop Chrome works too: enable reminders, add a goal whose start time is
  ~10 min out, then run `supabase functions invoke send-reminders` (or wait for
  the cron). A notification should appear; a row lands in `reminder_log`;
  invoking again sends no duplicate.
- Check the cron is firing:
  `select * from cron.job_run_details order by start_time desc limit 10;`

## Tuning
- Lead time: change `LEAD_MINUTES` in `supabase/functions/send-reminders/index.ts`.
- Reminders skip goals already checked off.
