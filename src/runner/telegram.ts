// Envoi Telegram. Le jeton fait partie de l'URL : il n'est JAMAIS journalisé ni placé dans un message d'erreur,
// et la réponse brute de Telegram n'est jamais renvoyée ni journalisée (seuls `ok`, le code et `retry_after` sont lus).

import type { FetchLike } from "./polymarket.ts";

export interface SendResult {
  /** true uniquement si Telegram a répondu `ok:true` (ou en DRY_RUN). */
  ok: boolean;
  dry: boolean;
  tries: number;
  /** Motif sobre et sans secret : "http 429", "réseau", "non configuré"… */
  error?: string;
}

export interface Sender {
  send(html: string, plain: string): Promise<SendResult>;
  readonly dryRun: boolean;
}

export interface TelegramOptions {
  token: string | undefined;
  chatId: string | undefined;
  dryRun: boolean;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxTries?: number;
}

/** Retire toute occurrence des secrets d'une chaîne (ceinture et bretelles). */
export function scrub(s: string, secrets: Array<string | undefined>): string {
  let out = s;
  for (const x of secrets) if (x && x.length >= 4) out = out.split(x).join("***");
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***");
}

export function createTelegram(o: TelegramOptions): Sender {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const f: FetchLike = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const maxTries = o.maxTries ?? 3;
  return {
    dryRun: o.dryRun,
    async send(html, plain) {
      if (o.dryRun) {
        log(`[DRY_RUN] alerte non envoyée :\n${plain}\n`);
        return { ok: true, dry: true, tries: 0 };
      }
      if (!o.token || !o.chatId) return { ok: false, dry: false, tries: 0, error: "Telegram non configuré (secrets absents)" };
      let error = "inconnu";
      let usePlain = false;
      for (let t = 1; t <= maxTries; t++) {
        let wait = 1000 * t;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 10000);
        try {
          const res = await f(`https://api.telegram.org/bot${o.token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(usePlain
              ? { chat_id: o.chatId, text: plain, disable_web_page_preview: true }
              : { chat_id: o.chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
            signal: ac.signal,
          });
          const body = await res.json().then((b) => b as { ok?: unknown; parameters?: { retry_after?: unknown } } | null, () => null);
          if (res.ok && body?.ok === true) return { ok: true, dry: false, tries: t };
          error = `http ${res.status}`;
          const ra = Number(body?.parameters?.retry_after);
          if (res.status === 429 && Number.isFinite(ra) && ra > 0) wait = Math.min(ra, 30) * 1000;
          // 400 : HTML refusé ? on retente une fois en texte brut plutôt que de perdre l'alerte.
          if (res.status === 400 && !usePlain) { usePlain = true; wait = 0; continue; }
          // 401/403/404 : réessayer ne changera rien (jeton ou chat invalide).
          if (res.status >= 400 && res.status < 500 && res.status !== 429) return { ok: false, dry: false, tries: t, error };
        } catch (e) {
          error = (e as { name?: string })?.name === "AbortError" ? "délai dépassé" : "réseau";
        } finally {
          clearTimeout(timer);
        }
        if (t < maxTries && wait > 0) await sleep(wait);
      }
      return { ok: false, dry: false, tries: maxTries, error: scrub(error, [o.token, o.chatId]) };
    },
  };
}
