import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/runner/polymarket.ts";
import { createTelegram, scrub } from "../src/runner/telegram.ts";

const TOKEN = "123456789:AAFakeTokenForTests_abcdefghijklmnop";
const CHAT = "987654321";

function fakeFetch(responses: Array<{ status: number; body?: unknown } | "throw">): { f: FetchLike; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r === "throw") throw new Error(`connect ECONNREFUSED ${url}`); // l'erreur réseau contient l'URL, donc le jeton
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body ?? {}, text: async () => "" };
  };
  return { f, calls };
}

describe("Telegram", () => {
  it("ok:true → envoyé ; requête conforme (chat_id, parse_mode HTML, aperçu désactivé)", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { ok: true, result: {} } }]);
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f }).send("<b>x</b>", "x");
    expect(r).toEqual({ ok: true, dry: false, tries: 1 });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0].body).toEqual({ chat_id: CHAT, text: "<b>x</b>", parse_mode: "HTML", disable_web_page_preview: true });
  });

  it("HTTP 200 sans ok:true n'est PAS un succès", async () => {
    const { f } = fakeFetch([{ status: 200, body: { ok: false } }]);
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f, sleep: async () => {} }).send("a", "a");
    expect(r.ok).toBe(false);
  });

  it("3 essais sur erreur réseau ; le jeton n'apparaît ni dans l'erreur ni dans le journal", async () => {
    const { f, calls } = fakeFetch(["throw"]);
    const logs: string[] = [];
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f, sleep: async () => {}, log: (l) => logs.push(l) }).send("a", "a");
    expect(r.ok).toBe(false);
    expect(r.tries).toBe(3);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(r) + logs.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(r) + logs.join("\n")).not.toContain(CHAT);
    expect(r.error).toBe("réseau");
  });

  it("429 : respecte retry_after puis réussit", async () => {
    const { f, calls } = fakeFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 7 } } }, { status: 200, body: { ok: true } }]);
    const waits: number[] = [];
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } }).send("a", "a");
    expect(r).toEqual({ ok: true, dry: false, tries: 2 });
    expect(waits).toEqual([7000]);
    expect(calls).toHaveLength(2);
  });

  it("400 (HTML refusé) : nouvel essai en texte brut, sans parse_mode", async () => {
    const { f, calls } = fakeFetch([{ status: 400, body: { ok: false } }, { status: 200, body: { ok: true } }]);
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f, sleep: async () => {} }).send("<b>x", "x brut");
    expect(r.ok).toBe(true);
    expect(calls[1].body).toEqual({ chat_id: CHAT, text: "x brut", disable_web_page_preview: true });
  });

  it("401 : échec immédiat, motif sobre", async () => {
    const { f, calls } = fakeFetch([{ status: 401, body: { ok: false, description: `Unauthorized ${TOKEN}` } }]);
    const r = await createTelegram({ token: TOKEN, chatId: CHAT, dryRun: false, fetchImpl: f, sleep: async () => {} }).send("a", "a");
    expect(r).toEqual({ ok: false, dry: false, tries: 1, error: "http 401" });
    expect(calls).toHaveLength(1);
  });

  it("DRY_RUN : aucune requête, texte écrit dans le journal", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const logs: string[] = [];
    const r = await createTelegram({ token: undefined, chatId: undefined, dryRun: true, fetchImpl: f, log: (l) => logs.push(l) }).send("<b>t</b>", "texte clair");
    expect(r).toEqual({ ok: true, dry: true, tries: 0 });
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("texte clair");
  });

  it("secrets absents (hors DRY_RUN) : échec sans requête", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const r = await createTelegram({ token: undefined, chatId: CHAT, dryRun: false, fetchImpl: f }).send("a", "a");
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("scrub : masque le jeton où qu'il soit", () => {
    expect(scrub(`GET https://api.telegram.org/bot${TOKEN}/sendMessage failed`, [TOKEN])).not.toContain(TOKEN);
    expect(scrub(`https://api.telegram.org/bot${TOKEN}/x`, [])).toBe("https://api.telegram.org/bot***/x");
  });
});
