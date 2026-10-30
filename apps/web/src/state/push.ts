/**
 * Web Push in the browser: register the tiny service worker and subscribe with
 * the daemon's VAPID key. Needs a secure context (https or localhost) and the
 * Notification permission; anything else returns null and the app carries on.
 */

function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof PushManager !== "undefined" && typeof Notification !== "undefined";
}

export async function subscribePush(publicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!pushSupported()) return null;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") return null;
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  return subscription.toJSON();
}

/** Drop this browser's subscription; returns its endpoint so the server can forget it. */
export async function unsubscribePush(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
