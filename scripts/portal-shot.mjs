/**
 * Best-effort authenticated portal screenshot via the Chrome DevTools Protocol
 * using only Node built-ins (fetch + global WebSocket) — no puppeteer/playwright,
 * so the lockfile is never touched. Logs in as the demo partner, injects the
 * session cookie, opens /earnings, and captures a PNG.
 *
 * Usage: node scripts/portal-shot.mjs [outputPath]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.SIM_BASE_URL ?? "http://127.0.0.1:3001";
const OUT = process.argv[2] ?? join(process.cwd(), "portal-earnings.png");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9333;

async function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener("message", onMsg); resolve(msg.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 15000);
  });
}

async function main() {
  // 1. Login -> session cookie.
  const login = await fetch(`${BASE}/api/portal/v1/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@demo.test", password: "Demo1234!" }),
  });
  if (login.status !== 200) throw new Error(`login gagal HTTP ${login.status}`);
  const setCookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")])[0];
  const m = setCookie.match(/^([^=]+)=([^;]+)/);
  const [, cookieName, cookieValue] = m;

  // 2. Launch headless Chrome with remote debugging.
  const userDir = mkdtempSync(join(tmpdir(), "kk-shot-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDir}`,
    "--window-size=1400,1600", "about:blank",
  ], { stdio: "ignore" });

  try {
    // 3. Find the page target's websocket.
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        const page = list.find((t) => t.type === "page");
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
    }
    if (!wsUrl) throw new Error("Chrome remote-debugging tidak siap");

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

    let id = 0;
    await cdp(ws, ++id, "Network.enable", {});
    await cdp(ws, ++id, "Page.enable", {});
    await cdp(ws, ++id, "Emulation.setDeviceMetricsOverride",
      { width: 1400, height: 1600, deviceScaleFactor: 1, mobile: false });
    await cdp(ws, ++id, "Network.setCookie", {
      name: cookieName, value: cookieValue, url: BASE, path: "/",
      httpOnly: true, secure: true, sameSite: "Lax",
    });

    // 4. Navigate to the earnings page and let it render.
    await cdp(ws, ++id, "Page.navigate", { url: `${BASE}/earnings` });
    await sleep(3500);

    const shot = await cdp(ws, ++id, "Page.captureScreenshot", { format: "png" });
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));

    // Report the URL actually shown (detect an auth redirect to /login).
    const { result } = await cdp(ws, ++id, "Runtime.evaluate", { expression: "location.pathname" });
    console.log(JSON.stringify({ ok: true, out: OUT, shownPath: result?.value ?? "?" }));
    ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => { console.error("SHOT-FAIL:", e.message); process.exit(1); });
