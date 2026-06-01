// =============================================================
// Service worker — handles Web Push for goal reminders.
// Scope is the repo root so it covers every page.
// =============================================================
'use strict';

// Activate immediately on update so new push logic takes effect.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Incoming push from the Supabase Edge Function.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Reminder', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Reminder';
  const options = {
    body: payload.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: payload.tag || undefined,        // collapse duplicates with same tag
    renotify: !!payload.tag,
    data: { url: payload.url || './index.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an open window or opens the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
