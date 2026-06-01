// =============================================================
// Push-notification setup for goal reminders.
// - Registers the service worker (sw.js).
// - Renders an "Enable reminders" button into #reminderMount.
// - On tap: asks permission, subscribes to Web Push, and stores
//   the subscription (+ timezone) in Supabase table push_subscriptions.
// The Edge Function `send-reminders` reads that table and pushes
// at each goal's time. iOS only delivers push to a Home-Screen PWA
// (iOS 16.4+), so we guide the user to install first.
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL = 'https://jxjjudnveewaledvuhpi.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_LVysxgZxmtBthSHk31YkBw_DuHPQiI2';
  // VAPID PUBLIC key — safe to ship. Private key lives only as a
  // Supabase Edge Function secret (see PUSH_SETUP.md).
  const VAPID_PUBLIC_KEY = 'BM5KaQR8xF3SNR4sqq3G3HMBHfgS50bfXHR0xhy3UwzrINB2Lb08MxRqMI6CgpFL6XDlJ0s27_FfPm0Dl7tWPts';

  const mount = document.getElementById('reminderMount');
  if (!mount) return;

  // ---- small style, matches the dashboard's button language ----
  const style = document.createElement('style');
  style.textContent = `
.reminder-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
.reminder-btn { padding: 9px 16px; border-radius: 11px; cursor: pointer;
  font-family: inherit; font-size: 13px; font-weight: 600;
  border: 1px solid rgba(125,211,252,0.18);
  background: rgba(125,211,252,0.08); color: #FAFAFA;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s; }
.reminder-btn:hover { background: rgba(125,211,252,0.14); }
.reminder-btn:disabled { opacity: 0.5; cursor: default; }
.reminder-btn.is-on { background: rgba(107,227,164,0.10); border-color: rgba(107,227,164,0.22); }
.reminder-hint { font-size: 11.5px; color: var(--text-tertiary); line-height: 1.5; flex-basis: 100%; }
`;
  document.head.appendChild(style);

  const row = document.createElement('div');
  row.className = 'reminder-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reminder-btn';
  const hint = document.createElement('div');
  hint.className = 'reminder-hint';
  row.appendChild(btn);
  row.appendChild(hint);
  mount.appendChild(row);

  const supported = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  function setHint(t) { hint.textContent = t || ''; }

  if (!supported) {
    btn.textContent = '🔔 Reminders unavailable';
    btn.disabled = true;
    setHint(isIOS
      ? 'Add this app to your Home Screen and open it from the icon (needs iOS 16.4+) to enable reminders.'
      : 'This browser does not support push notifications.');
    return;
  }
  if (isIOS && !isStandalone) {
    btn.textContent = '🔔 Enable reminders';
    btn.disabled = true;
    setHint('On iPhone: tap Share → Add to Home Screen, then open the app from that icon and come back here to enable reminders.');
    return;
  }

  // ---- helpers ----
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  let supa = null;
  function client() {
    if (!supa && window.supabase) supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return supa;
  }

  let swReg = null;
  async function ensureSW() {
    if (!swReg) swReg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    return swReg;
  }

  async function saveSubscription(sub) {
    const c = client();
    if (!c) return;
    const json = sub.toJSON();
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    await c.from('push_subscriptions').upsert({
      endpoint: sub.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
      timezone: tz,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
  }

  async function removeSubscription(endpoint) {
    const c = client();
    if (c) { try { await c.from('push_subscriptions').delete().eq('endpoint', endpoint); } catch (e) {} }
  }

  async function refresh() {
    const reg = await ensureSW();
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      btn.textContent = '🔔 Reminders on — tap to turn off';
      btn.classList.add('is-on');
      setHint('You\'ll get a heads-up ~10 min before each timed goal, and again at its end time.');
    } else if (Notification.permission === 'denied') {
      btn.textContent = '🔔 Reminders blocked';
      btn.classList.remove('is-on');
      setHint('Notifications are blocked in Settings. Allow them for this app to get reminders.');
    } else {
      btn.textContent = '🔔 Enable reminders';
      btn.classList.remove('is-on');
      setHint('Get notified before your timed goals — works even when the app is closed.');
    }
  }

  async function enable() {
    btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { await refresh(); return; }
      const reg = await ensureSW();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await saveSubscription(sub);
    } catch (e) {
      setHint('Could not enable reminders: ' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false;
      await refresh();
    }
  }

  async function disable() {
    btn.disabled = true;
    try {
      const reg = await ensureSW();
      const sub = await reg.pushManager.getSubscription();
      if (sub) { const ep = sub.endpoint; await sub.unsubscribe(); await removeSubscription(ep); }
    } catch (e) {}
    finally { btn.disabled = false; await refresh(); }
  }

  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-on')) disable(); else enable();
  });

  // Register SW early and reflect current state.
  ensureSW().then(refresh).catch(() => {
    btn.textContent = '🔔 Reminders unavailable';
    btn.disabled = true;
    setHint('Service worker failed to register.');
  });
})();
