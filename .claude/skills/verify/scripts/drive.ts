#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERIFY_HOME, isOurs, readState } from "./paths";

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
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext({ viewport, locale: "ja-JP" });
  const page = await context.newPage();
  const root = join(VERIFY_HOME, "evidence");
  const dir = join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${fileName(journey)}`);
  // Captures show production data copied into the branch.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  await page.goto(`${state.baseUrl}/auth/sign-in`);
  await page.getByLabel("Email").fill(state.ownerEmail);
  await page.getByLabel("Password").fill(state.ownerPassword);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 60_000 });

  const shot = async (rawLabel: string) => {
    const label = fileName(rawLabel);
    await page.waitForLoadState("networkidle").catch(() => {});
    // Panes stream in behind skeletons (components/panel/skeletons.tsx); networkidle fires before they resolve.
    await page.locator('[aria-busy="true"], [data-slot="skeleton"]').first().waitFor({ state: "detached", timeout: 60_000 });
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
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`not a panel path: ${path}`);
  const { page, base, dir, shot, close } = await openPanel(label);
  await page.goto(new URL(path, base).toString());
  await shot(label);
  await close();
  console.log(dir);
}
