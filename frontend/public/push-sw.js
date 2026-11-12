/**
 * push-sw.js — Service Worker mínimo só pra Web Push (lembrete de tarefa
 * pausada/com prazo chegando no computador mesmo com o navegador fechado —
 * ver subscribeToPush em src/utils/desktopNotify.js). Não é um Service
 * Worker de PWA/cache-offline (nenhum fetch/install/cache aqui de propósito
 * — o app não é uma PWA, isso serviria só pra complicar sem necessidade).
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'WPP Lab', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'WPP Lab';
  const options = {
    body: data.body || '',
    icon: data.icon || '/assets/app-icon-color.png',
    badge: '/assets/app-icon-color.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/app' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clique na notificação — foca uma aba já aberta do app se existir, senão
// abre uma nova. Mesmo padrão de app.js/n.onclick (notifyNewMessage), só
// que funcionando sem nenhuma aba viva (é o Service Worker quem responde).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/app';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
