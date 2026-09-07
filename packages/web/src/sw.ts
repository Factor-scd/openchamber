/// <reference lib="webworker" />

// Minimal service worker: push notifications and click routing only.
// No fetch handler, no precache — the app relies on the server for assets
// and the event pipeline handles reconnection. iOS Safari is fragile with
// complex SW bundles, so we keep this as lean as possible.

declare const self: ServiceWorkerGlobalScope;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = (event.data?.json() ?? null) as PushPayload | null;
    if (!payload) {
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'OpenChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as { url?: string } | null;
  const url = data?.url ?? '/';

  event.waitUntil((async () => {
    // Prefer focusing an already-open window (e.g. the installed PWA) and
    // navigating it to the target, instead of always spawning a new window.
    const target = new URL(url, self.location.origin).href;
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      try {
        if ('navigate' in client) {
          await client.navigate(target);
        }
      } catch {
        // navigate() can reject for uncontrolled clients; fall back to focus.
      }
      if ('focus' in client) {
        return client.focus();
      }
    }

    if (self.clients.openWindow) {
      return self.clients.openWindow(target);
    }
  })());
});
