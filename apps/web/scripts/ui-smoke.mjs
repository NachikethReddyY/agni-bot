#!/usr/bin/env node
/**
 * Browser smoke test against a running daemon and Vite server.
 *
 *   AGNI_URL=127.0.0.1:8788 AGNI_TOKEN=… bun run smoke:ui
 *
 * Pairs a fresh browser profile, sends a message, waits for the streamed reply,
 * then opens the agent switcher and settings. Screenshots land in artifacts/.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webURL = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const rawServer = process.env.AGNI_URL ?? "127.0.0.1:8788";
const token = process.env.AGNI_TOKEN?.trim();
if (!token) {
  console.error("AGNI_TOKEN is required (mint one with: bun run pair --name WebSmoke)");
  process.exit(2);
}

const server = rawServer
  .replace(/^wss?:\/\//, "")
  .replace(/^https?:\/\//, "")
  .replace(/\/ws$/, "");

const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(here, "../../../artifacts/web-e2e");
await mkdir(evidence, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(webURL, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Connect to Agni" }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: resolve(evidence, "01-pairing.png") });

  await page.getByText("Connect to a different server with a device token").click();
  await page.getByLabel("Agni server address").fill(server);
  await page.getByPlaceholder("Paste the token shown by the command").fill(token);
  await page.getByPlaceholder("This Browser").first().fill("Playwright");
  await page.getByRole("button", { name: "Connect with token", exact: true }).click();

  const composer = page.locator(".composer-input");
  await composer.waitFor({ timeout: 20_000 });
  await page.screenshot({ path: resolve(evidence, "02-chat.png") });

  // First run asks what to call the assistant. Finish that turn so the next
  // message exercises the normal model path rather than onboarding.
  await composer.fill("Ada");
  await page.keyboard.press("Meta+Enter");
  await page.getByText(/Nice to meet you|mock\(mock-model\): Ada/).waitFor({ timeout: 30_000 });

  const prompt = `browser smoke ${Date.now()}`;
  await composer.fill(prompt);
  await page.keyboard.press("Meta+Enter");
  await page.getByText(`mock(mock-model): ${prompt}`).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(evidence, "03-reply.png") });

  await page.keyboard.press("Meta+k");
  await page.getByRole("dialog", { name: "Switch agent" }).waitFor();
  await page.screenshot({ path: resolve(evidence, "04-agent-switcher.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Connect apps" }).click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "General" }).click();
  await page.screenshot({ path: resolve(evidence, "05-settings.png") });
  await page.getByRole("button", { name: "Back to chat" }).click();

  await page.getByRole("button", { name: "Server connection details" }).click();
  await page.getByText(/providers available/).waitFor();
  await page.screenshot({ path: resolve(evidence, "06-connection.png") });

  if (errors.length > 0) {
    throw new Error(`browser errors:\n${errors.join("\n")}`);
  }
  console.log("ui smoke ok");
} finally {
  await browser.close();
}
