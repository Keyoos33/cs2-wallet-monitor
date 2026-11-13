// Diagnostic Telegram (dépôt PUBLIC : n'affiche jamais le jeton ni le chat id, seulement des constats).
//   node scripts/telegram-diag.ts
// 1) secrets présents ? 2) jeton accepté (getMe) ? 3) envoi d'un message de test au chat : motif exact en cas de refus.

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const chat = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
const scrub = (s: string) => s.split(token || "\u0000").join("***").split(chat || "\u0000").join("***")
  .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***");
const say = (s: string) => console.log("diag: " + scrub(s));

async function call(method: string, body?: object): Promise<{ status: number; ok: boolean; description: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return { status: r.status, ok: j.ok === true, description: String(j.description ?? "") };
  } catch (e) {
    return { status: 0, ok: false, description: "erreur réseau (" + String((e as Error)?.name ?? "?") + ")" };
  }
}

async function main(): Promise<number> {
  say(`secret TELEGRAM_BOT_TOKEN : ${token ? "présent" : "ABSENT"} ; forme ${/^\d+:[A-Za-z0-9_-]{30,}$/.test(token) ? "valide (chiffres:clé)" : "INATTENDUE"}`);
  say(`secret TELEGRAM_CHAT_ID : ${chat ? "présent" : "ABSENT"} ; forme ${/^-?\d+$/.test(chat) ? "numérique" : chat.startsWith("@") ? "@nom de canal" : "INATTENDUE (doit être un nombre, ex. 123456789 ou -100…)"}`);
  if (!token || !chat) { say("=> secrets manquants : vérifier Settings → Secrets and variables → Actions → onglet « Secrets » (pas Variables, pas Environments, pas Dependabot)"); return 1; }
  const me = await call("getMe");
  say(`getMe : http ${me.status} ok=${me.ok}${me.ok ? " (jeton accepté)" : " — " + me.description}`);
  if (!me.ok) { say("=> jeton refusé par Telegram : recopier le jeton du bot depuis @BotFather"); return 1; }
  const when = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const s = await call("sendMessage", { chat_id: chat, text: `✅ Test du moniteur CS2 (diagnostic ${when}). Si tu lis ceci, les alertes arriveront ici.` });
  say(`sendMessage : http ${s.status} ok=${s.ok}${s.ok ? " (message accepté par Telegram)" : " — " + s.description}`);
  if (!s.ok && /chat not found/i.test(s.description)) say("=> chat introuvable : mauvais TELEGRAM_CHAT_ID, ou tu n'as jamais envoyé /start à ce bot");
  if (!s.ok && /blocked/i.test(s.description)) say("=> le bot est bloqué dans Telegram : le débloquer puis envoyer /start");
  return s.ok ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }, () => { say("erreur inattendue"); process.exitCode = 1; });
