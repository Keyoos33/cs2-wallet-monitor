// Dashboard du wallet CS2 (Polymarket). JavaScript natif, aucun framework, aucune dépendance.
// Données : schéma DashboardData (src/core/types.ts), lues à l'exécution sur la branche `data`.

// ── Configuration ────────────────────────────────────────────────────────────
const REMOTE = "https://raw.githubusercontent.com/Keyoos33/cs2-wallet-monitor/data/site/";
const params = new URLSearchParams(location.search);
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";
const SRC = params.get("src");
/** Ordre des sources : branche `data` (raw.githubusercontent) puis même origine ; l'inverse en développement local. */
const SOURCES = SRC === "remote" ? [REMOTE, "./"] : (SRC === "local" || IS_LOCAL) ? ["./", REMOTE] : [REMOTE, "./"];
const REFRESH_MS = 60_000;
const HB_OK_S = 120;        // battement de coeur < 2 min : vert
const HB_LATE_S = 900;      // < 15 min : orange ; au-delà : rouge
const DATA_MAX_AGE_MIN = 10; // relecture de data.json au moins toutes les 10 min, même sans nouveau battement
const ANALYSIS_MAX_AGE_MS = 30 * 60_000;
const PAGE = 40;
const FILL_PAGE = 80;
const TABS = ["open", "hist", "stats", "ana", "alerts"];

// ── Formatage (français) ─────────────────────────────────────────────────────
const NB = " ";
const MINUS = "−";
const nf = (min, max) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = nf(0, 0), NF1 = nf(1, 1), NF2 = nf(2, 2), NF02 = nf(0, 2), NF03 = nf(0, 3);
const ok = (x) => typeof x === "number" && Number.isFinite(x);
const sign = (x, s) => (x < 0 ? MINUS + s : s);
/** "12 500 $" ; centimes sous 1 000 $. */
function usd(x, dec) {
  if (!ok(x)) return "—";
  const a = Math.abs(x);
  const f = dec === 0 ? NF0 : dec === 2 ? NF2 : a >= 1000 ? NF0 : NF2;
  return sign(x, f.format(a)) + NB + "$";
}
const usdS = (x, dec) => (!ok(x) ? "—" : (x > 0 ? "+" : "") + usd(x, dec));
/** Montant compact pour les axes : "584 k$", "1,2 M$". */
function usdK(x) {
  if (!ok(x)) return "—";
  const a = Math.abs(x);
  const s = a >= 1e6 ? NF1.format(a / 1e6).replace(/,0$/, "") + NB + "M$" : a >= 1e3 ? NF0.format(a / 1e3) + NB + "k$" : NF0.format(a) + NB + "$";
  return sign(x, s);
}
const pct = (r, d = 1) => (!ok(r) ? "—" : sign(r, nf(d, d).format(Math.abs(r * 100))) + NB + "%");
const pctS = (r, d = 1) => (!ok(r) ? "—" : (r > 0 ? "+" : "") + pct(r, d));
const cents = (p) => (!ok(p) ? "—" : NF1.format(p * 100) + NB + "¢");
const odds = (o) => (!ok(o) ? "—" : NF2.format(o));
const shares = (n) => (!ok(n) ? "—" : (Math.abs(n) >= 100 ? NF0 : NF02).format(n));
const int = (n) => (!ok(n) ? "—" : NF0.format(n));
const cls = (x) => (!ok(x) || x === 0 ? "" : x > 0 ? "pos" : "neg");
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let TZ = "Europe/Zurich";
const fmtCache = new Map();
function dtf(opts) {
  const k = TZ + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, ...opts }); fmtCache.set(k, f); }
  return f;
}
const ts2d = (s) => new Date(s * 1000);
const fDay = (s) => (ok(s) ? dtf({ weekday: "short", day: "numeric", month: "short" }).format(ts2d(s)) : "—");
const fHM = (s) => (ok(s) ? dtf({ hour: "2-digit", minute: "2-digit" }).format(ts2d(s)) : "—");
const fHMS = (s) => (ok(s) ? dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ts2d(s)) : "—");
const fDate = (s) => (ok(s) ? dtf({ day: "numeric", month: "short", year: "numeric" }).format(ts2d(s)) : "—");
const fDateShort = (s) => (ok(s) ? dtf({ day: "2-digit", month: "2-digit", year: "2-digit" }).format(ts2d(s)) : "—");
const fDT = (s) => (ok(s) ? `${dtf({ day: "numeric", month: "short" }).format(ts2d(s))} ${fHM(s)}` : "—");
const fMonth = (s) => dtf({ month: "short", year: "2-digit" }).format(ts2d(s));
const sameDay = (a, b) => dtf({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ts2d(a)) === dtf({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ts2d(b));
const nowS = () => Math.floor(Date.now() / 1000);

/** "3 min", "2 h 05", "3 j". */
function dur(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 1) return "moins d'1 min";
  if (m < 60) return `${m}${NB}min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}${NB}h${NB}${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}${NB}j`;
}
const durS = (sec) => (!ok(sec) || sec < 0 ? "—" : sec < 90 ? `${NF0.format(Math.round(sec))}${NB}s` : dur(sec));

const STATUS = { open: "En cours", won: "Gagné", lost: "Perdu", void: "Remboursé", sold: "Vendu" };
const KIND = { NEW: "Nouveau pari", INCREASE: "Renfort", REDUCE: "Réduction", CLOSE: "Clôture", RESULT: "Résultat" };
const PHASE = { PRE: "PRÉ", LIVE: "LIVE", MIX: "PRÉ + LIVE", UNK: "Phase ?" };
const ROLE = { taker: "Taker", maker: "Maker", mix: "Maker + taker" };

// ── État ─────────────────────────────────────────────────────────────────────
const S = {
  data: null, D: null, hb: null, analysis: null, analysisAt: 0,
  dataKey: null, dataVer: 0, anaVer: 0, err: null, loading: false, lastOk: 0,
  tab: "open", rendered: {}, scroll: {},
  hist: { period: "all", type: "", phase: "", role: "", res: "", q: "" },
  histList: [], histShown: 0,
  breakdown: "type",
  expanded: new Set(),
  sheet: null,
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

const $ = (sel, root = document) => root.querySelector(sel);

// ── Chargement ───────────────────────────────────────────────────────────────
async function getJson(name, bust) {
  let last;
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}${name}?t=${encodeURIComponent(bust)}`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${name} : HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`${name} : indisponible`);
}

const validHb = (h) => h && typeof h === "object" && ok(h.ts);

async function refresh(force = false) {
  if (S.loading) return;
  S.loading = true;
  $("#refresh").classList.add("spin");
  const minute = Math.floor(Date.now() / 60_000);
  try {
    const hb = await getJson("heartbeat.json", minute);
    if (validHb(hb) && (!S.hb || hb.ts >= S.hb.ts)) S.hb = hb;
  } catch { /* le battement de coeur de data.json servira de repli */ }

  const key = `${S.hb ? S.hb.ts : "x"}-${Math.floor(minute / DATA_MAX_AGE_MIN)}`;
  if (force || !S.data || key !== S.dataKey) {
    try {
      const d = await getJson("data.json", key);
      if (!d || d.v !== 1 || !Array.isArray(d.pos)) throw new Error("data.json : format inattendu");
      if (!S.data || d.gen !== S.data.gen) { S.data = d; derive(); S.dataVer++; }
      S.dataKey = key;
      S.err = null;
      S.lastOk = Date.now();
    } catch (e) {
      S.err = e instanceof Error ? e.message : String(e);
    }
  }
  if (!S.analysis || force || Date.now() - S.analysisAt > ANALYSIS_MAX_AGE_MS) {
    try {
      const a = await getJson("analysis.json", Math.floor(minute / 30));
      if (a && typeof a === "object" && (!S.analysis || a.genere_le !== S.analysis.genere_le)) { S.analysis = a; S.anaVer++; }
      S.analysisAt = Date.now();
    } catch { /* l'onglet Analyse affichera l'absence */ }
  }
  S.loading = false;
  $("#refresh").classList.remove("spin");
  renderChrome();
  renderView();
}

// ── Dérivations (calculées une fois par version des données) ───────────────
function derive() {
  const d = S.data;
  TZ = d.tz || "Europe/Zurich";
  const pos = d.pos, matches = d.matches;
  const ext = new Array(pos.length);
  const byId = new Map();
  const types = new Map();
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    const m = matches[p.m] || {};
    let pre = 0, live = 0, unk = 0, tk = 0, mk = 0;
    for (const f of p.f) {
      const fl = f[5];
      if (fl & 4) unk++; else if (fl & 2) live++; else pre++;
      if (fl & 1) tk++; else mk++;
    }
    const phase = pre && live ? "MIX" : live ? "LIVE" : pre ? "PRE" : "UNK";
    const role = tk && mk ? "mix" : tk ? "taker" : "maker";
    ext[i] = {
      phase, role, closeTs: p.tr ?? p.t1,
      q: norm([m.match, m.tour, m.title, p.bet, p.out, p.tf].join(" ")),
    };
    byId.set(p.id, i);
    if (p.st !== "open" && !types.has(p.tk)) types.set(p.tk, p.tf);
  }
  const closed = [];
  for (let i = 0; i < pos.length; i++) if (pos[i].st !== "open") closed.push(i);
  closed.sort((a, b) => ext[b].closeTs - ext[a].closeTs);

  // Positions ouvertes groupées par match.
  const groups = new Map();
  for (let i = 0; i < pos.length; i++) {
    if (pos[i].st !== "open") continue;
    const g = groups.get(pos[i].m);
    if (g) g.push(i); else groups.set(pos[i].m, [i]);
  }
  const open = [...groups.entries()].map(([m, list]) => ({ m, list: list.sort((a, b) => pos[b].cash - pos[a].cash) }));
  S.D = { ext, byId, closed, open, types: [...types.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr")) };
  S.rendered = {};
}

// ── Chrome : en-tête, santé, bannière ───────────────────────────────────────
function health() {
  const hb = S.hb && (!S.data?.health || S.hb.ts >= S.data.health.ts) ? S.hb : S.data?.health ?? S.hb;
  if (!validHb(hb)) return { cls: "", label: "Santé inconnue", hb: null, age: null };
  const age = nowS() - hb.ts;
  if (age < HB_OK_S) return { cls: "ok", label: "Actif", hb, age };
  if (age < HB_LATE_S) return { cls: "late", label: "Retard", hb, age };
  return { cls: "down", label: "Arrêté ?", hb, age };
}

function renderChrome() {
  const d = S.data;
  const h = health();
  const btn = $("#health");
  btn.className = `health ${h.cls}`;
  btn.querySelector(".health-txt").textContent = h.hb ? `${h.label} · ${fHM(h.hb.ts)}` : h.label;
  btn.title = h.hb ? `Dernier battement de coeur : ${fDT(h.hb.ts)} (il y a ${dur(h.age)})` : "Aucun battement de coeur lu";
  if (d) {
    $("#wallet").textContent = d.wallet ? `${d.wallet.slice(0, 6)}…${d.wallet.slice(-4)}` : "—";
    const age = nowS() - d.gen;
    $("#updated").textContent = `Mis à jour il y a ${age < 60 ? "moins d'1 min" : dur(age)} · ${fDT(d.gen)}`;
  }
  const ban = $("#banner");
  if (S.err && d) {
    ban.hidden = false; ban.className = "banner";
    ban.innerHTML = `Actualisation impossible (${esc(S.err)}). Données affichées : ${esc(fDT(d.gen))}.<button type="button" data-act="retry">Réessayer</button>`;
  } else if (S.err) {
    ban.hidden = false; ban.className = "banner err";
    ban.innerHTML = `Impossible de charger les données (${esc(S.err)}).<button type="button" data-act="retry">Réessayer</button>`;
  } else ban.hidden = true;
  $("#skeleton").hidden = !!d || !!S.err;
}

/** Met à jour comptes à rebours et âges sans reconstruire les vues. */
function tick() {
  renderChrome();
  const n = nowS();
  document.querySelectorAll("[data-cd]").forEach((el) => { el.innerHTML = countdown(Number(el.dataset.cd), n); });
}

// ── Navigation ──────────────────────────────────────────────────────────────
function setTab(tab) {
  if (!TABS.includes(tab)) tab = "open";
  if (S.tab !== tab) S.scroll[S.tab] = window.scrollY;
  S.tab = tab;
  store.set("cs2dash.tab", tab);
  document.querySelectorAll("#tabs button").forEach((b) => { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.dataset.view !== tab; });
  renderView();
  window.scrollTo(0, S.scroll[tab] ?? 0);
}

function renderView() {
  if (!S.data) return;
  const tab = S.tab;
  const ver = tab === "ana" ? `${S.anaVer}` : `${S.dataVer}`;
  if (S.rendered[tab] === ver) return;
  S.rendered[tab] = ver;
  const el = $(`#v-${tab}`);
  if (tab === "open") renderOpen(el);
  else if (tab === "hist") renderHist(el);
  else if (tab === "stats") renderStats(el);
  else if (tab === "ana") renderAna(el);
  else if (tab === "alerts") renderAlerts(el);
}

// ── Vue « En cours » ────────────────────────────────────────────────────────
function countdown(start, n = nowS()) {
  if (!ok(start)) return `<span class="muted">Heure inconnue</span>`;
  const diff = start - n;
  if (diff > 0) return `dans ${dur(diff)}`;
  if (-diff < 5 * 3600) return `<span class="chip live">LIVE</span><br><span class="muted small">depuis ${dur(-diff)}</span>`;
  return `<span class="muted">Commencé il y a ${dur(-diff)}<br>résultat en attente</span>`;
}

function renderOpen(el) {
  const { data: d, D } = S;
  const n = nowS();
  const groups = D.open.slice().sort((a, b) => {
    const sa = d.matches[a.m]?.start, sb = d.matches[b.m]?.start;
    const ka = ok(sa) ? (sa <= n ? sa - 1e10 : sa) : 1e11, kb = ok(sb) ? (sb <= n ? sb - 1e10 : sb) : 1e11;
    return sa <= n && sb <= n ? sb - sa : ka - kb;
  });
  const nOpen = groups.reduce((s, g) => s + g.list.length, 0);
  const stake = groups.reduce((s, g) => s + g.list.reduce((t, i) => t + d.pos[i].cash, 0), 0);
  let h = `<h2 class="h">En cours</h2>
  <div class="summary">
    <div class="sbox"><div class="k">Misé en cours</div><div class="v">${usd(stake, 0)}</div></div>
    <div class="sbox"><div class="k">Positions</div><div class="v">${int(nOpen)}</div></div>
    <div class="sbox"><div class="k">Matchs</div><div class="v">${int(groups.length)}</div></div>
  </div>`;
  if (!groups.length) h += `<div class="card empty">Aucune position ouverte pour le moment.</div>`;
  for (const g of groups) {
    const m = d.matches[g.m] || {};
    const cash = g.list.reduce((t, i) => t + d.pos[i].cash, 0);
    h += `<article class="card">
      <div class="match-h">
        <div class="row1">
          <div class="match-name">${esc(m.match || m.title || m.slug)}${m.fmt ? `<span class="fmt">${esc(m.fmt)}</span>` : ""}</div>
          <div class="cd" data-cd="${ok(m.start) ? m.start : ""}">${countdown(m.start, n)}</div>
        </div>
        <div class="match-sub">${esc(m.tour || "Tournoi inconnu")}</div>
        <div class="match-tot"><span>${ok(m.start) ? `${esc(fDay(m.start))} · ${esc(fHM(m.start))}` : "Début non renseigné"}</span><span>${g.list.length} position${g.list.length > 1 ? "s" : ""} · ${usd(cash, 0)}</span></div>
      </div>
      ${g.list.map((i) => openPosRow(i)).join("")}
    </article>`;
  }
  el.innerHTML = h;
}

function openPosRow(i) {
  const p = S.data.pos[i];
  const exp = S.expanded.has(p.id);
  const mkDiff = ok(p.mk) && ok(p.px) ? p.mk - p.px : null;
  const winPay = p.held + p.sold; // si l'issue gagne, chaque part détenue rapporte 1 $
  return `<div class="opos${exp ? " open" : ""}" data-pos="${i}">
    <button class="opos-btn" type="button" data-act="toggle" data-i="${i}" aria-expanded="${exp}">
      <div class="bet"><span>${esc(p.bet)}</span><span class="caret">▾</span></div>
      <div class="bet-type">${esc(p.tf)}${p.ex ? "" : " · intitulé brut"}${p.warn ? ` · <span class="chip warn">à vérifier</span>` : ""}</div>
      <div class="kv">
        <div><span class="k">Mise</span><span class="v">${usd(p.cash)}</span></div>
        <div><span class="k">Prix moy.</span><span class="v">${cents(p.px)}</span></div>
        <div><span class="k">Cote</span><span class="v">${odds(p.odds)}</span></div>
        <div><span class="k">Initiale</span><span class="v">${usd(p.init)}</span></div>
        <div><span class="k">Renforts</span><span class="v">${p.add > 0.005 ? "+" + usd(p.add) : usd(0, 0)}</span></div>
        <div><span class="k">Fills</span><span class="v">${int(p.nf)}</span></div>
      </div>
    </button>
    ${exp ? `<div class="opos-more">
      <div class="wincond"><b>Pour gagner</b>${esc(p.win || "Condition non traduite : voir l'intitulé du marché ci-dessous.")}</div>
      ${p.ex ? "" : `<div class="raw">${esc(p.q)} → ${esc(p.out)}</div>`}
      <div class="kv">
        <div><span class="k">Dont frais</span><span class="v">${usd(p.fee)}</span></div>
        <div><span class="k">Prix actuel</span><span class="v">${ok(p.mk) ? `${cents(p.mk)} <small class="${cls(mkDiff)}">${mkDiff >= 0 ? "+" : MINUS}${NF1.format(Math.abs(mkDiff * 100))}${NB}¢</small>` : "—"}</span></div>
        <div><span class="k">Si gagné</span><span class="v ${cls(winPay - p.cash)}">${usdS(winPay - p.cash)}</span></div>
      </div>
      ${ok(p.mk) ? `<div class="raw">Prix actuel : dernier prix Gamma connu, indicatif. « Si gagné » : ${shares(p.held)} parts × 1 $ − mise.</div>` : ""}
      ${p.pnl !== null ? `<div class="raw">PnL réalisé par des ventes : <b class="${cls(p.pnl)}">${usdS(p.pnl)}</b></div>` : ""}
      <button class="btn block" type="button" data-act="sheet" data-i="${i}">Voir les ${int(p.nf)} fill${p.nf > 1 ? "s" : ""}</button>
    </div>` : ""}
  </div>`;
}

// ── Vue « Historique » ──────────────────────────────────────────────────────
function seg(name, opts, cur) {
  return `<div class="seg" role="group" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === cur}">${esc(l)}</button>`).join("")}</div>`;
}
function select(name, label, opts, cur) {
  return `<label class="sel"><span hidden>${esc(label)}</span><select data-f="${name}" class="${cur ? "on" : ""}" aria-label="${esc(label)}">
    <option value="">${esc(label)}</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}

function renderHist(el) {
  const f = S.hist;
  el.innerHTML = `<h2 class="h">Historique</h2>
  <div class="filters">
    ${seg("period", [["7", "7 j"], ["30", "30 j"], ["all", "Tout"]], f.period)}
    <div class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="search" id="hq" placeholder="Équipe, tournoi…" value="${esc(f.q)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      <button class="clear" type="button" data-act="clearq" aria-label="Effacer"${f.q ? "" : " hidden"}>×</button>
    </div>
    <div class="sel-grid">
      ${select("type", "Type de marché", S.D.types, f.type)}
      ${select("phase", "PRÉ / LIVE", [["PRE", "PRÉ uniquement"], ["LIVE", "LIVE uniquement"], ["MIX", "PRÉ + LIVE"], ["UNK", "Phase inconnue"]], f.phase)}
      ${select("role", "Maker / taker", [["maker", "Maker uniquement"], ["taker", "Taker uniquement"], ["mix", "Maker + taker"]], f.role)}
      ${select("res", "Résultat", [["won", "Gagné"], ["lost", "Perdu"], ["void", "Remboursé"], ["sold", "Vendu"]], f.res)}
    </div>
  </div>
  <div class="fsum" id="hsum"></div>
  <div class="card list" id="hlist"></div>
  <div class="more" id="hmore"></div>`;
  applyHist();
}

function applyHist() {
  const { data: d, D } = S;
  const f = S.hist;
  const n = nowS();
  const since = f.period === "all" ? -Infinity : n - Number(f.period) * 86400;
  const terms = norm(f.q).split(/\s+/).filter(Boolean);
  const out = [];
  let st = 0, pnl = 0, w = 0, lo = 0;
  for (const i of D.closed) {
    const p = d.pos[i], x = D.ext[i];
    if (x.closeTs < since) break; // liste triée du plus récent au plus ancien
    if (f.type && p.tk !== f.type) continue;
    if (f.phase && x.phase !== f.phase) continue;
    if (f.role && x.role !== f.role) continue;
    if (f.res && p.st !== f.res) continue;
    if (terms.length && !terms.every((t) => x.q.includes(t))) continue;
    out.push(i);
    st += p.cash; pnl += p.pnl ?? 0;
    if (p.st === "won") w++; else if (p.st === "lost") lo++;
  }
  S.histList = out;
  S.histShown = 0;
  const active = f.type || f.phase || f.role || f.res || f.q || f.period !== "all";
  $("#hsum").innerHTML = out.length
    ? `<span><b>${int(out.length)}</b> position${out.length > 1 ? "s" : ""}</span><span>Misé <b>${usd(st, 0)}</b></span><span>PnL <b class="${cls(pnl)}">${usdS(pnl, 0)}</b></span><span>ROI <b class="${cls(pnl)}">${st > 0 ? pctS(pnl / st) : "—"}</b></span><span>Réussite <b>${w + lo ? pct(w / (w + lo), 0) : "—"}</b></span>${active ? `<button class="reset" type="button" data-act="reset">Réinitialiser</button>` : ""}`
    : `<span>Aucune position</span>${active ? `<button class="reset" type="button" data-act="reset">Réinitialiser</button>` : ""}`;
  $("#hlist").innerHTML = out.length ? "" : `<div class="empty">Aucune position close ne correspond à ces filtres.</div>`;
  $("#hlist").hidden = false;
  moreHist();
}

function moreHist() {
  const { data: d, D } = S;
  const list = S.histList;
  const from = S.histShown, to = Math.min(list.length, from + PAGE);
  let h = "";
  for (let k = from; k < to; k++) {
    const i = list[k], p = d.pos[i], x = D.ext[i], m = d.matches[p.m] || {};
    h += `<button class="hrow" type="button" data-act="sheet" data-i="${i}">
      <div class="l1"><span class="betl">${esc(p.bet)}</span><span class="pnl ${cls(p.pnl)}">${usdS(p.pnl)}</span></div>
      <div class="l2"><span class="m">${esc(m.match || m.title)}${m.tour ? ` · ${esc(m.tour)}` : ""}</span><span class="r ${cls(p.roi)}">${pctS(p.roi)}</span></div>
      <div class="l3"><span class="chip ${p.st}">${STATUS[p.st] ?? esc(p.st)}</span><span class="chip ${x.phase === "LIVE" ? "lv" : x.phase === "PRE" ? "pre" : ""}">${PHASE[x.phase]}</span><span>${esc(fDateShort(x.closeTs))}</span><span class="amt">${usd(p.cash)} → ${usd(p.pay + p.sold)}</span></div>
    </button>`;
  }
  $("#hlist").insertAdjacentHTML("beforeend", h);
  S.histShown = to;
  const more = $("#hmore");
  if (to < list.length) {
    more.innerHTML = `<button class="btn" type="button" data-act="morehist">Afficher plus (${int(list.length - to)} restantes)</button><div class="sentinel" id="hsent"></div>`;
    histObserver.observe($("#hsent"));
  } else more.innerHTML = list.length > PAGE ? `<span class="muted small">Fin de la liste · ${int(list.length)} positions</span>` : "";
}
const histObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) { histObserver.unobserve(e.target); if (S.tab === "hist") moreHist(); }
  }, { rootMargin: "600px 0px" })
  : { observe() {}, unobserve() {} };

// ── Feuille de détail ───────────────────────────────────────────────────────
function openSheet(i) {
  const d = S.data, p = d.pos[i];
  if (!p) return;
  const m = d.matches[p.m] || {};
  const x = S.D.ext[i];
  const closed = p.st !== "open";
  const body = $("#sheet-body");
  const winPay = p.held + p.sold;
  body.innerHTML = `
    <h2>${esc(p.bet)}</h2>
    <p class="sub">${esc(m.match || m.title)}${m.fmt ? ` (${esc(m.fmt)})` : ""}${m.tour ? ` · ${esc(m.tour)}` : ""}<br>${ok(m.start) ? `Début prévu ${esc(fDay(m.start))} à ${esc(fHM(m.start))}` : "Début non renseigné"}</p>
    <div class="chips"><span class="chip ${p.st}">${STATUS[p.st] ?? esc(p.st)}</span><span class="chip">${esc(p.tf)}</span><span class="chip ${x.phase === "LIVE" ? "lv" : x.phase === "PRE" ? "pre" : ""}">${PHASE[x.phase]}</span><span class="chip ${x.role === "mix" ? "" : x.role}">${ROLE[x.role]}</span>${p.warn ? `<span class="chip warn">${esc(p.warn)}</span>` : ""}</div>
    <div class="wincond"><b>Pour gagner</b>${esc(p.win || "Condition non traduite.")}</div>
    ${p.ex ? "" : `<div class="raw">Type de marché non reconnu, intitulé brut : ${esc(p.q)} → ${esc(p.out)}</div>`}
    <div class="dgrid">
      <div><div class="k">Mise (frais inclus)</div><div class="v">${usd(p.cash)}</div><div class="k">dont ${usd(p.fee)} de frais</div></div>
      <div><div class="k">Prix moyen · cote</div><div class="v">${cents(p.px)} <small>· ${odds(p.odds)}</small></div></div>
      <div><div class="k">Mise initiale</div><div class="v">${usd(p.init)}</div></div>
      <div><div class="k">Renforts</div><div class="v">${usd(p.add)}</div></div>
      <div><div class="k">Parts achetées</div><div class="v">${shares(p.sh)}${p.held !== p.sh ? ` <small>détenues ${shares(p.held)}</small>` : ""}</div></div>
      <div><div class="k">Fills</div><div class="v">${int(p.nf)}</div></div>
      ${closed ? `
      <div><div class="k">Encaissé</div><div class="v">${usd(p.pay)}${p.sold ? ` <small>+ ventes ${usd(p.sold)}</small>` : ""}</div></div>
      <div><div class="k">Règlement</div><div class="v">${ok(p.set) ? NF02.format(p.set) + NB + "$/part" : "—"}</div></div>
      <div><div class="k">PnL</div><div class="v ${cls(p.pnl)}">${usdS(p.pnl)}</div></div>
      <div><div class="k">ROI</div><div class="v ${cls(p.roi)}">${pctS(p.roi)}</div></div>` : `
      <div><div class="k">Prix actuel (indicatif)</div><div class="v">${cents(p.mk)}</div></div>
      <div><div class="k">Si gagné</div><div class="v ${cls(winPay - p.cash)}">${usdS(winPay - p.cash)}</div></div>`}
      <div><div class="k">Premier fill</div><div class="v small">${esc(fDT(p.t0))}</div></div>
      <div><div class="k">${closed ? "Résolution" : "Dernier fill"}</div><div class="v small">${esc(fDT(closed ? p.tr ?? p.t1 : p.t1))}</div></div>
    </div>
    <div class="linkrow">
      ${m.slug ? `<a class="btn primary" href="https://polymarket.com/event/${encodeURIComponent(m.slug)}" target="_blank" rel="noopener">Polymarket ↗</a>` : ""}
    </div>
    <h3 class="h fhead"><span>Fills (${int(p.f.length)})</span><span class="muted small">heure de Zurich</span></h3>
    <div class="card fills" id="sheet-fills"></div>
    <div class="more" id="sheet-more"></div>`;
  S.sheet = { i, shown: 0 };
  moreFills();
  const dlg = $("#sheet");
  if (!dlg.open) {
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    document.documentElement.classList.add("locked");
    history.pushState({ sheet: true }, "");
  }
  body.scrollTop = 0;
}

function moreFills() {
  const sh = S.sheet;
  if (!sh) return;
  const p = S.data.pos[sh.i];
  const from = sh.shown, to = Math.min(p.f.length, from + FILL_PAGE);
  let h = "";
  let prevTs = from > 0 ? p.f[from - 1][0] : null;
  for (let k = from; k < to; k++) {
    const [ts, n, px, cash, fee, fl, tx, lag] = p.f[k];
    const day = prevTs === null || !sameDay(prevTs, ts);
    prevTs = ts;
    h += `<div class="frow">
      <div class="f1"><span class="t">${day ? `${esc(fDateShort(ts))} ` : ""}${esc(fHMS(ts))}</span><span>${shares(n)} × ${cents(px)}</span><span class="c">${fl & 8 ? "+" : ""}${usd(cash)}</span></div>
      <div class="f2">
        <span class="chip ${fl & 1 ? "taker" : "maker"}">${fl & 1 ? "Taker" : "Maker"}</span>
        <span class="chip ${fl & 4 ? "" : fl & 2 ? "lv" : "pre"}">${fl & 4 ? "Phase ?" : fl & 2 ? "LIVE" : "PRÉ"}</span>
        ${fl & 8 ? `<span class="chip warn">Vente</span>` : fl & 16 ? `<span class="chip">Renfort</span>` : `<span class="chip">Initiale</span>`}
        ${fee > 0 ? `<span>frais ${usd(fee, 2)}</span>` : ""}
        ${lag !== null && lag !== undefined ? `<span>détecté +${durS(lag)}</span>` : ""}
        ${tx ? `<a class="tx" href="https://polygonscan.com/tx/${encodeURIComponent(tx)}" target="_blank" rel="noopener">${esc(tx.slice(0, 8))}… ↗</a>` : ""}
      </div>
    </div>`;
  }
  $("#sheet-fills").insertAdjacentHTML("beforeend", h);
  sh.shown = to;
  $("#sheet-more").innerHTML = to < p.f.length ? `<button class="btn" type="button" data-act="morefills">Afficher ${int(Math.min(FILL_PAGE, p.f.length - to))} fills de plus (${int(p.f.length - to)} restants)</button>` : "";
}

function closeSheet(fromPop = false) {
  const dlg = $("#sheet");
  if (!dlg.open) return;
  if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open");
  document.documentElement.classList.remove("locked");
  S.sheet = null;
  if (!fromPop && history.state?.sheet) history.back();
}

// ── Vue « Stats » ───────────────────────────────────────────────────────────
const BREAKDOWNS = [["type", "Type"], ["phase", "PRÉ/LIVE"], ["role", "Maker/taker"], ["bucket", "Mise"], ["month", "Mois"]];

function renderStats(el) {
  const d = S.data, s = d.stats;
  const reb = (s.rebates_taker ?? 0) + (s.rebates_maker ?? 0);
  const tiles = [
    ["Total misé", usd(s.staked, 0), `frais inclus · dont ${usd(s.staked_open, 0)} en cours`],
    ["PnL", `<span class="${cls(s.pnl)}">${usdS(s.pnl, 0)}</span>`, `positions closes, net de frais, hors rebates`],
    ["ROI", `<span class="${cls(s.roi)}">${pctS(s.roi)}</span>`, `PnL / ${usd(s.staked_closed, 0)} misés (clos)`],
    ["Taux de réussite", pct(s.win_rate), `${int(s.won)} gagnés · ${int(s.lost)} perdus · ${int(s.void)} remb.${s.sold ? ` · ${int(s.sold)} vendus` : ""}`],
    ["Rebates", usd(reb, 0), `taker ${usd(s.rebates_taker, 0)} · maker ${usd(s.rebates_maker, 0)}<br>PnL rebates inclus <b class="${cls(s.pnl_with_rebates)}">${usdS(s.pnl_with_rebates, 0)}</b>`],
    ["Positions ouvertes", int(s.n_open), `${usd(s.staked_open, 0)} engagés · ${int(s.n_closed)} closes`],
  ];
  el.innerHTML = `<h2 class="h">Statistiques</h2>
    <p class="lede">${int(s.n_pos)} positions sur ${int(s.n_matches)} matchs, ${int(s.n_fills)} fills · du ${esc(fDate(s.first_ts))} au ${esc(fDate(s.last_ts))}</p>
    <div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${sub}</div></div>`).join("")}</div>
    <p class="note">Frais payés ${usd(s.fees, 0)} · dépôts ${usd(s.deposits, 0)} · retraits ${usd(s.withdrawals, 0)}</p>
    <div class="card chart-card">
      <div class="chart-head">
        <div class="chart-title">PnL cumulé</div>
        <div class="legend"><span><i style="background:var(--s1)"></i>Hors rebates</span><span><i style="background:var(--s2)"></i>Rebates inclus</span></div>
      </div>
      <div class="chart" id="eq"></div>
      <p class="note" style="margin-top:2px">Par date de résolution. Touchez ou glissez sur la courbe pour lire les valeurs.</p>
    </div>
    <h3 class="h">Ventilation des positions closes</h3>
    ${seg("breakdown", BREAKDOWNS, S.breakdown).replace('class="seg"', 'class="seg scroll"')}
    <div class="card" style="margin-top:10px" id="btab"></div>
    <p class="note" id="bnote"></p>`;
  drawEquity();
  renderBreakdown();
}

function renderBreakdown() {
  const rows = S.data.by?.[S.breakdown] ?? [];
  const prorata = S.breakdown === "phase" || S.breakdown === "role";
  let tn = 0, tst = 0, tp = 0;
  for (const r of rows) { tn += r.n; tst += r.st; tp += r.pnl; }
  $("#btab").innerHTML = rows.length ? `<table class="btable">
    <thead><tr><th>${esc(BREAKDOWNS.find((b) => b[0] === S.breakdown)[1])}</th><th>Pos.</th><th>Misé</th><th>PnL</th><th>ROI</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.l)}<small>${int(r.w)} G · ${int(r.lo)} P · ${int(r.v)} R</small></td><td>${int(r.n)}</td><td>${usdK(r.st)}</td><td class="${cls(r.pnl)}">${r.pnl > 0 ? "+" : ""}${usdK(r.pnl)}</td><td class="${cls(r.roi)}">${pctS(r.roi)}</td></tr>`).join("")}</tbody>
    ${prorata ? "" : `<tfoot><tr><td>Total</td><td>${int(tn)}</td><td>${usdK(tst)}</td><td class="${cls(tp)}">${tp > 0 ? "+" : ""}${usdK(tp)}</td><td class="${cls(tp)}">${tst > 0 ? pctS(tp / tst) : "—"}</td></tr></tfoot>`}
  </table>` : `<div class="empty">Aucune donnée.</div>`;
  $("#bnote").textContent = prorata
    ? "Mise et PnL attribués au prorata du cash de chaque fill ; une position mixte compte dans les deux lignes (G/P/R = positions touchées)."
    : "G/P/R : positions gagnées, perdues, remboursées. Positions closes uniquement.";
}

function niceTicks(lo, hi, count) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function drawEquity() {
  const box = $("#eq");
  if (!box) return;
  const d = S.data;
  const raw = Array.isArray(d.eq) ? d.eq : [];
  if (raw.length < 1) { box.innerHTML = `<div class="empty">Aucune position close pour l'instant.</div>`; return; }
  // Avant la première résolution, le PnL cumulé est nul par définition.
  const t0 = ok(d.stats.first_ts) && d.stats.first_ts < raw[0][0] ? d.stats.first_ts : raw[0][0];
  const pts = [[t0, 0, 0], ...raw];
  const W = Math.max(280, Math.round(box.clientWidth || 340)), H = 210;
  const L = 46, R = 8, T = 10, B = 24;
  const xs = pts.map((p) => p[0]);
  const xmin = xs[0], xmax = Math.max(xs[xs.length - 1], xmin + 86400);
  let ymin = 0, ymax = 0;
  for (const p of pts) { ymin = Math.min(ymin, p[1], p[2]); ymax = Math.max(ymax, p[1], p[2]); }
  const pad = (ymax - ymin || 1) * 0.06;
  ymin -= ymin < 0 ? pad : 0; ymax += pad;
  const ticks = niceTicks(ymin, ymax, 4).filter((v) => v >= ymin && v <= ymax);
  const X = (t) => L + ((t - xmin) / (xmax - xmin)) * (W - L - R);
  const Y = (v) => T + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - T - B);
  const path = (k) => {
    let s = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][k]).toFixed(1)}`;
    for (let j = 1; j < pts.length; j++) s += `H${X(pts[j][0]).toFixed(1)}V${Y(pts[j][k]).toFixed(1)}`;
    return s + `H${X(xmax).toFixed(1)}`;
  };
  // Graduations mensuelles (1er du mois, heure locale du fuseau ≈ UTC à quelques heures près).
  const months = [];
  const dt = new Date(xmin * 1000); dt.setUTCDate(1); dt.setUTCHours(0, 0, 0, 0);
  for (dt.setUTCMonth(dt.getUTCMonth() + 1); dt.getTime() / 1000 <= xmax; dt.setUTCMonth(dt.getUTCMonth() + 1)) months.push(dt.getTime() / 1000);
  const step = Math.ceil(months.length / Math.max(1, Math.floor((W - L) / 62)));
  const mt = months.filter((_, k) => k % step === 0);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="PnL cumulé : ${esc(usdS(raw[raw.length - 1][1], 0))} hors rebates, ${esc(usdS(raw[raw.length - 1][2], 0))} rebates inclus">
    ${ticks.map((v) => `<line class="${v === 0 ? "zero" : "gl"}" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(usdK(v))}</text>`).join("")}
    ${mt.map((t) => `<line class="gl" x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${H - B}" y2="${H - B + 4}"/><text class="ax" x="${X(t).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(fMonth(t))}</text>`).join("")}
    <path class="l2" d="${path(2)}"/>
    <path class="l1" d="${path(1)}"/>
    <g id="eqx" visibility="hidden"><line class="xh" y1="${T}" y2="${H - B}"/><circle class="d2" r="4.5"/><circle class="d1" r="4.5"/></g>
    <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="eqhit"/>
  </svg><div class="tip" id="eqtip" hidden></div>`;
  const svg = box.querySelector("svg"), g = box.querySelector("#eqx"), tip = box.querySelector("#eqtip");
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = xmin + ((px - L) / (W - L - R)) * (xmax - xmin);
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid - 1; }
    const p = pts[lo];
    const cx = Math.min(Math.max(X(t), L), W - R);
    g.setAttribute("visibility", "visible");
    g.querySelector("line").setAttribute("x1", cx); g.querySelector("line").setAttribute("x2", cx);
    g.querySelector(".d1").setAttribute("cx", cx); g.querySelector(".d1").setAttribute("cy", Y(p[1]));
    g.querySelector(".d2").setAttribute("cx", cx); g.querySelector(".d2").setAttribute("cy", Y(p[2]));
    tip.hidden = false;
    tip.innerHTML = `<b>${lo === 0 ? "Avant la 1re résolution" : `au ${esc(fDate(p[0]))}`}</b><div><i style="background:var(--s1)"></i>${esc(usdS(p[1], 0))}</div><div><i style="background:var(--s2)"></i>${esc(usdS(p[2], 0))}</div>`;
    const sx = (cx / W) * r.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(sx - tw / 2, 0), r.width - tw)}px`;
    tip.style.top = `${Math.max(0, (Math.min(Y(p[1]), Y(p[2])) / H) * r.height - tip.offsetHeight - 10)}px`;
  };
  const hide = () => { g.setAttribute("visibility", "hidden"); tip.hidden = true; };
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  svg.addEventListener("pointercancel", hide);
}

// ── Vue « Analyse » ─────────────────────────────────────────────────────────
function cell(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isFinite(v) ? (v < 0 ? MINUS : "") + (Number.isInteger(v) ? NF0 : NF03).format(Math.abs(v)) : "—";
  return esc(v);
}

function renderAna(el) {
  const a = S.analysis;
  if (!a) { el.innerHTML = `<h2 class="h">Analyse</h2><div class="card empty">Analyse indisponible pour le moment.</div>`; return; }
  const per = a.periode || {};
  const pTs = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t / 1000; };
  const sections = Array.isArray(a.sections) ? a.sections : [];
  const meth = a.methode && typeof a.methode === "object" ? a.methode : null;
  el.innerHTML = `<h2 class="h">Analyse</h2>
    <div class="card verdict"><div class="k">Verdict</div><p>${esc(a.verdict || "—")}</p></div>
    <p class="meta-line">Période du ${esc(fDate(pTs(per.debut)))} au ${esc(fDate(pTs(per.fin)))} · ${int(per.ordres)} ordres · ${int(per.positions)} positions (${int(per.positions_reglees)} réglées) · ${int(per.matchs)} matchs<br>Analyse générée le ${esc(fDT(pTs(a.genere_le)))}</p>
    ${sections.map((s) => `<details class="sec" data-sec="${esc(s.id)}">
      <summary>${esc(s.titre)}</summary>
      <div class="sec-body">
        ${s.resume ? `<p>${esc(s.resume)}</p>` : ""}
        ${(s.tableaux || []).map((t) => `<div class="atable"><div class="tt">${esc(t.titre)}</div><div class="tscroll"><table>
          <thead><tr>${(t.colonnes || []).map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${(t.lignes || []).map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div></div>`).join("")}
        ${s.avertissements?.length ? `<div class="warns"><b>À savoir</b><ul>${s.avertissements.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </details>`).join("")}
    ${meth ? `<details class="sec"><summary>Méthode</summary><div class="sec-body"><dl class="mlist">${Object.entries(meth).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${Array.isArray(v) ? v.map(cell).join(" · ") : cell(v)}</dd>`).join("")}</dl></div></details>` : ""}`;
}

// ── Vue « Alertes » ─────────────────────────────────────────────────────────
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function renderAlerts(el) {
  const d = S.data;
  const h = health();
  const hb = h.hb;
  const alerts = Array.isArray(d.alerts) ? d.alerts : [];
  const real = alerts.filter((a) => !a.test);
  const mDet = median(real.map((a) => a.ld).filter(ok)), mSend = median(real.map((a) => a.ls).filter(ok)), mTot = median(real.map((a) => a.ts - a.tf).filter(ok));
  el.innerHTML = `<h2 class="h">Alertes</h2>
    <div class="card hcard ${h.cls}">
      <div class="hstate"><span class="dot"></span>${h.cls === "ok" ? "Moniteur actif" : h.cls === "late" ? "Moniteur en retard" : h.cls === "down" ? "Moniteur arrêté ?" : "État du moniteur inconnu"}</div>
      <div class="hsub">${hb ? `Dernier battement de coeur ${esc(fDT(hb.ts))} · il y a <span data-age="${hb.ts}">${dur(nowS() - hb.ts)}</span>` : "Aucun battement de coeur lu."}</div>
      ${hb ? `<div class="dgrid">
        <div><div class="k">Dernier relevé OK</div><div class="v small">${esc(fDT(hb.last_poll_ok_ts))}</div></div>
        <div><div class="k">Dernier fill vu</div><div class="v small">${hb.last_fill_ts ? esc(fDT(hb.last_fill_ts)) : "—"}</div></div>
        <div><div class="k">Relevés · erreurs</div><div class="v">${int(hb.polls)} <small>· ${int(hb.errors)} err.${ok(hb.polls) && hb.polls > 0 && ok(hb.errors) ? ` (${pct(hb.errors / hb.polls, 1)})` : ""}</small></div></div>
        <div><div class="k">En attente · à renvoyer</div><div class="v">${int(hb.pending)} <small>· ${int(hb.outbox)}</small></div></div>
        <div><div class="k">Run démarré</div><div class="v small">${esc(fDT(hb.started_ts))}</div></div>
        <div><div class="k">Run</div><div class="v small">${esc(hb.run_id || "—")}</div></div>
      </div>` : ""}
      <p class="note">Vert : battement &lt; 2 min · orange : &lt; 15 min · rouge au-delà. Le moniteur publie un battement toutes les 5 min environ (et la source raw.githubusercontent garde ~5 min en cache).</p>
    </div>
    <div class="summary" style="margin-top:14px">
      <div class="sbox"><div class="k">Détection</div><div class="v">${durS(mDet)}</div></div>
      <div class="sbox"><div class="k">Envoi</div><div class="v">${durS(mSend)}</div></div>
      <div class="sbox"><div class="k">Total</div><div class="v">${durS(mTot)}</div></div>
    </div>
    <p class="note" style="margin:-6px 2px 12px">Latences médianes sur ${int(real.length)} alerte${real.length > 1 ? "s" : ""} réelle${real.length > 1 ? "s" : ""} (hors TEST) : fill → détection, détection → envoi Telegram (regroupement ≈ 20 s inclus), fill → envoi.</p>
    <div class="card list">${alerts.length ? alerts.map(alertRow).join("") : `<div class="empty">Aucune alerte envoyée pour l'instant.</div>`}</div>`;
}

function alertRow(a, idx) {
  const pi = S.D.byId.get(a.tok);
  const p = pi !== undefined ? S.data.pos[pi] : null;
  const total = ok(a.ts) && ok(a.tf) && a.ts >= a.tf ? a.ts - a.tf : null;
  return `<div class="arow" data-act="alexp" data-k="${idx}">
    <div class="a1">${a.test ? `<span class="chip test">TEST</span>` : ""}<span class="chip kind">${esc(KIND[a.k] ?? a.k)}</span>${a.ok ? "" : `<span class="chip dry">Simulation (non envoyée)</span>`}<span class="when">${esc(fDT(a.ts))}</span></div>
    <div class="atitle">${esc(a.title)}</div>
    ${a.text ? `<div class="atext">${esc(a.text)}</div>` : ""}
    <div class="alat">
      <span>${a.k === "RESULT" ? "Résolution" : "Fill"} <b>${esc(fHMS(a.tf))}</b> → envoi <b>${esc(fHMS(a.ts))}</b>${total !== null ? ` · <b>${durS(total)}</b>` : ""}</span>
      ${a.k === "RESULT" ? "" : `<span>détection ${durS(a.ld)} + envoi ${durS(a.ls)}</span>`}
      <span>${int(a.n)} fill${a.n > 1 ? "s" : ""} · ${usd(a.usd)}</span>
      ${ok(a.ask) ? `<span>meilleur ask ${cents(a.ask)}${ok(a.avail) ? ` · ${usd(a.avail, 0)} dispo` : ""}</span>` : ""}
    </div>
    ${p ? `<button class="apos btn" type="button" data-act="sheet" data-i="${pi}" style="min-height:34px;margin-top:8px">Voir la position</button>` : ""}
  </div>`;
}

// ── Événements ──────────────────────────────────────────────────────────────
let qTimer = 0;
function onClick(e) {
  const t = e.target.closest("[data-act], [data-tab], [data-seg] button");
  if (!t) return;
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  const segEl = t.closest("[data-seg]");
  if (segEl && !t.dataset.act) {
    const name = segEl.dataset.seg, v = t.dataset.v;
    segEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === t)));
    if (name === "period") { S.hist.period = v; applyHist(); }
    else if (name === "breakdown") { S.breakdown = v; renderBreakdown(); }
    return;
  }
  const act = t.dataset.act;
  if (act === "toggle") {
    const p = S.data.pos[Number(t.dataset.i)];
    if (S.expanded.has(p.id)) S.expanded.delete(p.id); else S.expanded.add(p.id);
    t.closest(".opos").outerHTML = openPosRow(Number(t.dataset.i));
  } else if (act === "sheet") { e.stopPropagation(); openSheet(Number(t.dataset.i)); }
  else if (act === "morehist") moreHist();
  else if (act === "morefills") moreFills();
  else if (act === "retry") refresh(true);
  else if (act === "clearq") { S.hist.q = ""; const i = $("#hq"); i.value = ""; t.hidden = true; applyHist(); i.focus(); }
  else if (act === "reset") { S.hist = { period: "all", type: "", phase: "", role: "", res: "", q: "" }; renderHist($("#v-hist")); }
  else if (act === "alexp") t.classList.toggle("exp");
}

function onInput(e) {
  const t = e.target;
  if (t.id === "hq") {
    const clear = t.parentElement.querySelector(".clear");
    clear.hidden = !t.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.hist.q = t.value; applyHist(); }, 160);
  }
}
function onChange(e) {
  const t = e.target;
  if (t.matches("select[data-f]")) {
    S.hist[t.dataset.f] = t.value;
    t.classList.toggle("on", !!t.value);
    applyHist();
  }
}

let timer = 0, ticker = 0;
function startTimers() {
  stopTimers();
  timer = setInterval(() => refresh(), REFRESH_MS);
  ticker = setInterval(tick, 20_000);
}
function stopTimers() { clearInterval(timer); clearInterval(ticker); }

function init() {
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  $("#refresh").addEventListener("click", () => refresh(true));
  $("#health").addEventListener("click", () => setTab("alerts"));
  $("#sheet-close").addEventListener("click", () => closeSheet());
  const dlg = $("#sheet");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeSheet(); }); // clic sur le fond
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(); });
  window.addEventListener("popstate", () => { if ($("#sheet").open) closeSheet(true); });
  let rz = 0;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.tab === "stats" && S.data) drawEquity(); }, 150); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimers();
    else { tick(); if (Date.now() - S.lastOk > REFRESH_MS - 5000) refresh(); startTimers(); }
  });
  const saved = store.get("cs2dash.tab");
  setTab(TABS.includes(saved) ? saved : "open");
  refresh().then(() => { window.__dashReady = performance.now(); });
  startTimers();
}

init();
