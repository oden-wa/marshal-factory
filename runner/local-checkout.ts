import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { repoSettings } from "../db/schema";
import { CONFIG_PATH } from "../lib/config";
import { installationTokens, type RepoName } from "../lib/github/app";
import { localHost } from "../lib/host";
import { addRepoToFactoryConfig, wireTarget } from "../lib/install-target";
import { parseDetail, type LocalCheckout } from "../lib/onboarding";
import { repoName } from "../lib/repo-name";
import { checkoutRepo } from "../lib/worktrees";
import { config } from "./config";
import { thisMachine } from "./heartbeat";

const FACTORY_ROOT = resolve(import.meta.dirname, "..");
const CLONE_TIMEOUT_MS = 4 * 60_000;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const reasonOf = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : String(error)).slice(0, 500);

async function cloneRepo(repo: string, path: string) {
  const token = await installationTokens.get(repo as RepoName);
  mkdirSync(dirname(path), { recursive: true });
  const askpassDir = mkdtempSync(join(tmpdir(), "marshal-factory-askpass-"));
  const askpass = join(askpassDir, "askpass.sh");
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf \'%s\\n\' \'x-access-token\' ;;\n  *) printf \'%s\\n\' "$MARSHAL_FACTORY_GITHUB_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  chmodSync(askpass, 0o700);
  try {
    await localHost.run("git", ["-c", "credential.helper=", "clone", "--quiet", `https://github.com/${repo}.git`, path], {
      timeoutMs: CLONE_TIMEOUT_MS,
      env: { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", MARSHAL_FACTORY_GITHUB_TOKEN: token },
    });
  } finally {
    rmSync(askpassDir, { recursive: true, force: true });
  }
}

async function addRepoDurable(path: string) {
  const added = addRepoToFactoryConfig(path, { log: () => {} });
  if (added === "missing") throw new Error(`${CONFIG_PATH} does not exist, so the checkout would not survive a runner restart`);
}

const outputOf = (error: unknown) => {
  const failure = error as { message?: string; stdout?: string; stderr?: string };
  return [failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n");
};

async function ensureT3Project(path: string) {
  try {
    await localHost.run(localHost.t3, ["project", "add", path, "--title", basename(path)], { timeoutMs: 30_000 });
  } catch (error) {
    if (!/ProjectAlreadyExistsError|project already exists/i.test(outputOf(error))) throw error;
  }
}

export const localCheckoutRuntime = {
  clone: cloneRepo,
  wire: (path: string) => wireTarget(path, FACTORY_ROOT, () => {}),
  addRepo: addRepoDurable,
  ensureProject: ensureT3Project,
  origin: checkoutRepo,
  machine: thisMachine,
  now: () => new Date(),
};

async function updateLocalCheckout(repo: string, change: (current: LocalCheckout | undefined, now: string) => LocalCheckout | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(repoSettings).where(eq(repoSettings.repo, repo)).for("update");
    if (!row) return false;
    const detail = parseDetail(row.onboarding_detail);
    const next = change(detail.localCheckout, localCheckoutRuntime.now().toISOString());
    if (!next) return false;
    await tx
      .update(repoSettings)
      .set({ onboarding_detail: { ...detail, localCheckout: next } })
      .where(eq(repoSettings.repo, repo));
    return true;
  });
}

async function checkoutMatches(path: string, repo: string) {
  try {
    return sameRepo(await localCheckoutRuntime.origin(path), repo);
  } catch {
    return false;
  }
}

async function configuredCheckout(repo: string) {
  for (const path of config.factory.repos) {
    if (await checkoutMatches(path, repo)) return resolve(path);
  }
  return null;
}

async function checkoutPath(repo: string) {
  const configured = await configuredCheckout(repo);
  if (configured) return { path: configured, exists: true };
  const candidates = [...new Set([join(config.factory.checkoutRoot, repoName(repo)), join(config.factory.checkoutRoot, repo.replace("/", "-"))])];
  const blocked: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) return { path, exists: false };
    if (await checkoutMatches(path, repo)) return { path, exists: true };
    blocked.push(path);
  }
  throw new Error(`no checkout path is free for ${repo}: ${blocked.join(", ")} already hold something else`);
}

function rememberCheckout(path: string) {
  if (!config.factory.repos.some((repo) => resolve(repo) === path)) config.factory.repos.push(path);
}

export async function prepareRepoCheckout(repo: string) {
  const machine = await localCheckoutRuntime.machine();
  const marked = await updateLocalCheckout(repo, (current, now) => {
    if (current?.state === "ready") return null;
    return {
      state: "preparing",
      requestedAt: current?.requestedAt ?? now,
      updatedAt: now,
      machine: machine.name,
      ...(current?.path && { path: current.path }),
    };
  });
  if (!marked) return { repo, skipped: "no pending checkout" };

  try {
    const picked = await checkoutPath(repo);
    const path = resolve(picked.path);
    let cloned = false;
    if (!picked.exists) {
      await localCheckoutRuntime.clone(repo, path);
      cloned = true;
    }
    const origin = await localCheckoutRuntime.origin(path);
    if (!sameRepo(origin, repo)) throw new Error(`${path} is a checkout of ${origin}, not ${repo}`);
    await localCheckoutRuntime.wire(path);
    await localCheckoutRuntime.addRepo(path);
    await localCheckoutRuntime.ensureProject(path);
    rememberCheckout(path);
    await updateLocalCheckout(repo, (current, now) =>
      current
        ? { ...current, state: "ready", machine: machine.name, path, updatedAt: now, failure: undefined }
        : null,
    );
    return { repo, path, cloned, state: "ready" };
  } catch (error) {
    const reason = reasonOf(error);
    await updateLocalCheckout(repo, (current, now) =>
      current
        ? { ...current, state: "failed", machine: machine.name, updatedAt: now, failure: { reason, at: now } }
        : null,
    );
    throw error;
  }
}
