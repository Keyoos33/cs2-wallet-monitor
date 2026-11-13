// Câblage commun aux points d'entrée : configuration, journal, secrets (environnement uniquement),
// client API, Telegram, magasin. Les secrets ne sont jamais écrits ni journalisés.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, mergeConfig } from "../core/config.ts";
import type { Config } from "../core/config.ts";
import { toMarketMeta } from "../core/gamma.ts";
import { describeBet } from "../core/translate.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { createApi } from "./polymarket.ts";
import { createStore } from "./store.ts";
import type { Store } from "./store.ts";
import { createTelegram, scrub } from "./telegram.ts";

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let file: Record<string, unknown> | null = null;
  try { file = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "config.json"), "utf8")) as Record<string, unknown>; } catch { file = null; }
  // Toute clé de config.json peut être remplacée par une variable d'environnement du même nom (essais locaux).
  const fromEnv: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) if (env[k] !== undefined && env[k] !== "") fromEnv[k] = env[k];
  return mergeConfig(file, fromEnv);
}

export interface Runtime extends PipelineDeps {
  store: Store;
  rawDir: string | null;
  sleep: (ms: number) => Promise<void>;
  dryRun: boolean;
}

export function createRuntime(env: Record<string, string | undefined> = process.env): Runtime {
  const cfg = loadConfig(env);
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.GITHUB_TOKEN];
  const log = (line: string): void => { console.log(`${new Date().toISOString().slice(0, 19)}Z ${scrub(line, secrets)}`); };
  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN === "true";
  const runId = env.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const rawDir = path.join(REPO_DIR, "data", "raw");
  return {
    cfg,
    log,
    dryRun,
    runId,
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    store: createStore({ repoDir: REPO_DIR, storeDir: env.STORE_DIR || undefined, log }),
    api: createApi({ wallet: cfg.WALLET, timeoutMs: cfg.HTTP_TIMEOUT_MS }),
    sender: createTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, dryRun, log }),
    describe: describeBet,
    toMarketMeta,
    rawDir: fs.existsSync(path.join(rawDir, "activity.jsonl")) ? rawDir : null,
  };
}
