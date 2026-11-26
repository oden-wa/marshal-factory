#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator } from "playwright-core";
import { VERIFY_HOME, isOurs, readState, servesPort, type StackState } from "./paths";
import { panelOnlyProxy } from "./proxy";

const TOOLS = join(VERIFY_HOME, "tools");
const PLAYWRIGHT_CORE = "playwright-core@1.52.0";

async function loadPlaywright() {
  const entry = join(TOOLS, "node_modules", "playwright-core", "index.js");
  if (!existsSync(entry)) {
    // Kept out of package.json: the panel does not depend on a browser driver.
    mkdirSync(TOOLS, { recursive: true });
    execFileSync("bun", ["add", PLAYWRIGHT_CORE], { cwd: TOOLS, stdio: "inherit" });
  }
  return (await import(entry)) as typeof import("playwright-core");
}

function chromePath(): string {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("no Chrome found: set CHROME_PATH");
  return found;
}

function fileName(name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw new Error(`not a plain file name: ${JSON.stringify(name)}`);
  return name;
}

export async function openPanel(journey: string, viewport = { width: 1440, height: 900 }) {
  const state = readState();
  if (!state) throw new Error("no stack: run `stack.ts up`");
  // Another checkout's panel may hold the port now; never hand it this branch's owner password.
  if (!isOurs(state)) throw new Error("the stack's next dev is not running: run `stack.ts down` and `up` again");
  const { chromium } = await loadPlaywright();
  // Cookies are not port-scoped and the branch holds production rows, so the browser reaches nothing but this panel.
  const proxy = await panelOnlyProxy(state);
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      // The page renders production rows; refuse to run it without Chrome's sandbox.
      chromiumSandbox: true,
      // <-loopback> drops Chrome's built-in bypass, so localhost goes through the proxy too.
      args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
  } catch (error) {
    proxy.close();
    throw error;
  }
  browser.on("disconnected", proxy.close);
  try {
    return await signIn(browser, state, journey, viewport);
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function signIn(browser: Browser, state: StackState, journey: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const root = join(VERIFY_HOME, "evidence");
  const dir = join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${fileName(journey)}`);
  // Captures show production data copied into the branch.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  await page.goto(`${state.baseUrl}/auth/sign-in`);
  // Checked again after the first Playwright install, which can take minutes, and right before the password is typed.
  if (!servesPort(state) || new URL(page.url()).origin !== new URL(state.baseUrl).origin) {
    throw new Error(`${state.baseUrl} is not served by this stack's next dev: run \`stack.ts down\` and \`up\` again`);
  }
  await page.locator('input[type="email"]').fill(state.ownerEmail);
  await page.locator('input[type="password"]').fill(state.ownerPassword);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 60_000 });
  if (new URL(page.url()).origin !== new URL(state.baseUrl).origin) {
    throw new Error(`sign-in landed on ${page.url()}, not this stack's panel`);
  }

  // After a click, pass what the new screen shows (a heading, the selected row): networkidle may already hold for the old one.
  // `expected` is the page the caller navigated to: a redirect to another panel page must not be saved under its label.
  const shot = async (rawLabel: string, ready?: Locator, expected?: URL) => {
    const label = fileName(rawLabel);
    if (ready) await ready.waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    // Panes stream in behind skeletons (components/panel/skeletons.tsx); networkidle fires before they resolve.
    await page.locator('[aria-busy="true"], [data-slot="skeleton"]').first().waitFor({ state: "detached", timeout: 60_000 });
    // Checked last, so a redirect or an expired session during the waits is not saved as evidence.
    const current = new URL(page.url());
    const moved = expected && (current.pathname !== expected.pathname || current.search !== expected.search);
    if (current.origin !== new URL(state.baseUrl).origin || current.pathname.startsWith("/auth") || moved || !servesPort(state)) {
      throw new Error(`${label}: the browser is on ${current.href}, not this stack's panel`);
    }
    await page.screenshot({ path: join(dir, `${label}.png`), fullPage: true });
    writeFileSync(join(dir, `${label}.txt`), `${page.url()}\n\n${await page.locator("body").innerText()}`);
    writeFileSync(join(dir, `${label}.aria.yml`), await page.locator("body").ariaSnapshot());
  };
  return { page, base: state.baseUrl, dir, shot, close: () => browser.close() };
}

if (import.meta.main) {
  const [command, path, label] = process.argv.slice(2);
  if (command !== "shot" || !path || !label) {
    console.error("usage: drive.ts shot <path> <label>");
    process.exit(2);
  }
  if (!path.startsWith("/")) throw new Error(`not a panel path: ${path}`);
  const { page, base, dir, shot, close } = await openPanel(label);
  // Resolved against the base the browser signed in to; cookies are not isolated by port, so nothing else is opened.
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) {
    await close();
    throw new Error(`not a panel path: ${path}`);
  }
  const response = await page.goto(url.toString());
  if (!response?.ok()) {
    await close();
    throw new Error(`${path} answered ${response?.status() ?? "nothing"}`);
  }
  try {
    await shot(label, undefined, url);
  } finally {
    await close();
  }
  console.log(dir);
}
