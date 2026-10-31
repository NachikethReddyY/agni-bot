// Minimal service worker: show a pushed notification, focus the app on click.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain text push */ }
  event.waitUntil(self.registration.showNotification(data.title || "Agni", { body: data.body || "", tag: data.threadID || data.title }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) =>
      windows.length ? windows[0].focus() : self.clients.openWindow("/"),
    ),
  );
});
