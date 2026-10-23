import { createHash } from "node:crypto";

// Agni's web-client colors and system typography, kept self-contained for the
// loopback callback: this page must not load third-party assets or scripts.
const styles = `
:root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0d0d0f; color: #f4f4f6; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100svh; padding: 24px; display: grid; place-items: center; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 440px; padding: 40px 32px; text-align: center; background: #17171a; border: 1px solid rgb(255 255 255 / 8%); border-radius: 18px; box-shadow: 0 18px 40px rgb(0 0 0 / 25%); }
.brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 28px; font-size: 24px; font-weight: 650; letter-spacing: -0.04em; }
.brand svg { width: 28px; height: 28px; color: #ff3146; }
.label { margin: 0 0 12px; color: #9a9aa1; font-size: 12px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; }
h1 { margin: 0 0 14px; font-size: 24px; font-weight: 600; line-height: 1.25; letter-spacing: -0.035em; text-wrap: balance; }
.message { margin: 0; color: #c3c3ca; font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
footer { margin-top: 28px; padding-top: 22px; border-top: 1px solid rgb(255 255 255 / 8%); color: #9a9aa1; font-size: 13px; line-height: 1.6; }
::selection { background: rgb(255 49 70 / 35%); }
@media (max-width: 480px) { body { padding: 20px; } main { padding: 32px 24px; } }
`;
const styleHash = createHash("sha256").update(styles).digest("base64");

/* Flame: Lucide Icons (ISC), Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
const flame = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/></svg>`;

export function chatGPTPage(message: string, status = 200): Response {
  const text = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const connected = status >= 200 && status < 300;
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Agni · ChatGPT</title><style>${styles}</style></head>
<body><main aria-labelledby="result-title">
<div class="brand">${flame}<span>Agni</span></div>
<p class="label">ChatGPT connection</p>
<h1 id="result-title">${connected ? "You're connected" : "Sign-in needs attention"}</h1>
<p class="message" role="${connected ? "status" : "alert"}">${text}</p>
<footer>${connected ? "You're ready to chat. Return to Agni to continue." : "Return to Agni and select Continue with ChatGPT to try again."}</footer>
</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}
