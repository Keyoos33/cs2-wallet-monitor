// Persistance de l'état : branche git `data` (orpheline) extraite dans `.data-branch/`,
// ou simple répertoire local (variable STORE_DIR, sans git) pour les essais, ou mémoire (rejeu TEST).
//
//   state/state.json   state/handover.json   state/reconcile-request.json   state/reconcile.json
//   ledger/fills.jsonl ledger/events.jsonl   ledger/alerts.jsonl            ledger/markets.json
//   site/data.json     site/heartbeat.json
//
// Mode git : `.data-branch/` est un « worktree » du dépôt principal (il hérite donc des identifiants
// laissés par actions/checkout). Clone initial superficiel (--depth=1), puis `fetch` normaux.
// `sync()` = add + commit + push ; en cas de rejet : fetch + rebase + nouvel essai.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AlertRecord, Fill, LedgerEvent, MarketEntry, RunnerState } from "../core/types.ts";

export type SyncResult = "ok" | "failed" | "conflict";

export interface Store {
  readonly kind: "git" | "dir" | "memory";
  /** Prépare le répertoire (clone / création de la branche orpheline). */
  init(): void;
  readJson<T>(rel: string): T | null;
  writeJson(rel: string, value: unknown, pretty?: boolean): void;
  writeText(rel: string, text: string): void;
  remove(rel: string): void;
  exists(rel: string): boolean;
  readJsonl<T>(rel: string): T[];
  appendJsonl(rel: string, rows: unknown[]): void;
  /** Valide et pousse les changements. "failed" : réseau (on réessaiera) ; "conflict" : la branche distante a divergé. */
  sync(message: string): SyncResult;
  /** Rafraîchit la vue de la branche distante (sans toucher aux fichiers locaux). false si échec. */
  fetchRemote(): boolean;
  /** Lit un fichier JSON dans la dernière vue de la branche distante (mode dir/mémoire : fichier local). */
  readRemoteJson<T>(rel: string): T | null;
  /** Abandonne tout changement local et se cale sur la branche distante. */
  resetToRemote(): boolean;
  /** Remplace l'historique de la branche par un seul commit (même contenu) pour borner la taille du dépôt. */
  squash(message: string): boolean;
}

export const FILES = {
  state: "state/state.json",
  handover: "state/handover.json",
  reconcileRequest: "state/reconcile-request.json",
  reconcileReport: "state/reconcile.json",
  fills: "ledger/fills.jsonl",
  events: "ledger/events.jsonl",
  alerts: "ledger/alerts.jsonl",
  markets: "ledger/markets.json",
  data: "site/data.json",
  heartbeat: "site/heartbeat.json",
} as const;

function parseJsonl<T>(text: string): { rows: T[]; validBytes: number } {
  const rows: T[] = [];
  let pos = 0, valid = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    const complete = nl !== -1;
    if (!complete) nl = text.length;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (line === "") { if (complete) valid = pos; continue; }
    try {
      rows.push(JSON.parse(line) as T);
      if (complete) valid = pos; else valid = text.length;
    } catch {
      // Ligne tronquée (écriture interrompue) : on s'arrête là, la suite sera redétectée par le flux.
      break;
    }
  }
  return { rows, validBytes: valid };
}

class DirStore implements Store {
  readonly kind: "git" | "dir" = "dir";
  dir: string;
  constructor(dir: string) { this.dir = dir; }
  protected p(rel: string): string { return path.join(this.dir, rel); }

  init(): void { fs.mkdirSync(this.dir, { recursive: true }); }

  exists(rel: string): boolean { return fs.existsSync(this.p(rel)); }

  readJson<T>(rel: string): T | null {
    try { return JSON.parse(fs.readFileSync(this.p(rel), "utf8")) as T; } catch { return null; }
  }

  writeText(rel: string, text: string): void {
    const file = this.p(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file); // remplacement atomique
  }

  writeJson(rel: string, value: unknown, pretty = false): void {
    this.writeText(rel, JSON.stringify(value, null, pretty ? 1 : undefined) + "\n");
  }

  remove(rel: string): void { try { fs.rmSync(this.p(rel)); } catch { /* absent */ } }

  readJsonl<T>(rel: string): T[] {
    let text: string;
    try { text = fs.readFileSync(this.p(rel), "utf8"); } catch { return []; }
    const { rows, validBytes } = parseJsonl<T>(text);
    if (validBytes < text.length) {
      // Réparation d'une fin de fichier tronquée : on ne garde que les lignes complètes.
      const buf = Buffer.from(text, "utf8");
      const keep = Buffer.byteLength(text.slice(0, validBytes), "utf8");
      fs.writeFileSync(this.p(rel), buf.subarray(0, keep));
    }
    return rows;
  }

  appendJsonl(rel: string, rows: unknown[]): void {
    if (rows.length === 0) return;
    const file = this.p(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = "";
    try {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const fd = fs.openSync(file, "r");
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        fs.closeSync(fd);
        if (b[0] !== 0x0a) prefix = "\n";
      }
    } catch { /* nouveau fichier */ }
    fs.appendFileSync(file, prefix + rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  sync(_message: string): SyncResult { return "ok"; }
  fetchRemote(): boolean { return true; }
  readRemoteJson<T>(rel: string): T | null { return this.readJson<T>(rel); }
  resetToRemote(): boolean { return true; }
  squash(_message: string): boolean { return true; }
}

class GitStore extends DirStore {
  override readonly kind = "git" as const;
  private repo: string;
  private remote: string;
  private branch: string;
  private log: (line: string) => void;

  constructor(o: { repoDir: string; dir: string; remote?: string; branch?: string; log?: (line: string) => void }) {
    super(o.dir);
    this.repo = o.repoDir;
    this.remote = o.remote ?? "origin";
    this.branch = o.branch ?? "data";
    this.log = o.log ?? (() => {});
  }

  private git(cwd: string, args: string[], timeoutMs = 120000): string {
    return execFileSync("git", ["-c", "user.name=cs2-wallet-monitor", "-c", "user.email=cs2-wallet-monitor@users.noreply.github.com",
      "-c", "advice.detachedHead=false", "-c", "gc.auto=0", ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /** Exécute git ; renvoie null (et journalise une ligne sobre, sans sortie brute) en cas d'échec. */
  private tryGit(cwd: string, args: string[], what: string, quiet = false): string | null {
    try { return this.git(cwd, args); } catch (e) {
      if (!quiet) {
        const code = (e as { status?: number })?.status;
        this.log(`git: échec « ${what} »${typeof code === "number" ? ` (code ${code})` : ""}`);
      }
      return null;
    }
  }

  override init(): void {
    const dotGit = path.join(this.dir, ".git");
    const ref = `refs/remotes/${this.remote}/${this.branch}`;
    if (fs.existsSync(dotGit)) {
      // Répertoire déjà présent (reprise locale) : on se recale sur la branche distante si elle existe.
      if (this.tryGit(this.dir, ["fetch", "-q", this.remote, `+refs/heads/${this.branch}:${ref}`], "fetch", true) !== null) {
        this.git(this.dir, ["reset", "-q", "--hard", ref]);
        this.git(this.dir, ["clean", "-fdq"]);
      }
      return;
    }
    this.tryGit(this.repo, ["worktree", "prune"], "worktree prune", true);
    const has = this.tryGit(this.repo, ["ls-remote", "--exit-code", "--heads", this.remote, this.branch], "ls-remote", true);
    if (has !== null && has.trim() !== "") {
      this.git(this.repo, ["fetch", "-q", "--depth=1", this.remote, `+refs/heads/${this.branch}:${ref}`]);
      this.git(this.repo, ["worktree", "add", "-q", "-f", "-B", this.branch, this.dir, ref]);
      return;
    }
    // Premier démarrage : création de la branche orpheline.
    this.log(`store: branche « ${this.branch} » absente, création (orpheline)`);
    this.git(this.repo, ["worktree", "add", "-q", "-f", "--detach", this.dir, "HEAD"]);
    this.git(this.dir, ["checkout", "-q", "--orphan", this.branch]);
    this.git(this.dir, ["rm", "-rfq", "--ignore-unmatch", "."]);
    this.git(this.dir, ["clean", "-fdq"]);
    this.writeText("README.md", "Branche de données du moniteur (écrite uniquement par le runner). Ne pas modifier à la main.\n");
    this.git(this.dir, ["add", "-A"]);
    this.git(this.dir, ["commit", "-q", "-m", "data: initialisation"]);
    this.git(this.dir, ["push", "-q", this.remote, `HEAD:refs/heads/${this.branch}`]);
  }

  private push(): boolean {
    return this.tryGit(this.dir, ["push", "-q", this.remote, `HEAD:refs/heads/${this.branch}`], "push", true) !== null;
  }

  override sync(message: string): SyncResult {
    try {
      this.git(this.dir, ["add", "-A"]);
      const staged = this.tryGit(this.dir, ["diff", "--cached", "--quiet"], "diff", true) === null;
      if (staged) this.git(this.dir, ["commit", "-q", "-m", message]);
    } catch {
      this.log("git: échec du commit local");
      return "failed";
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.push()) return "ok";
      // Rejet : la branche distante a avancé (successeur, réconciliation) → on rejoue nos commits par-dessus.
      if (!this.fetchRemote()) { this.log("git: push et fetch en échec (réseau ?), nouvel essai plus tard"); return "failed"; }
      if (this.tryGit(this.dir, ["rebase", "-q", "FETCH_HEAD"], "rebase", true) === null) {
        this.tryGit(this.dir, ["rebase", "--abort"], "rebase --abort", true);
        this.log("git: la branche distante a divergé (conflit)");
        return "conflict";
      }
    }
    this.log("git: push rejeté 3 fois, nouvel essai plus tard");
    return "failed";
  }

  override fetchRemote(): boolean {
    return this.tryGit(this.dir, ["fetch", "-q", this.remote, `refs/heads/${this.branch}`], "fetch", true) !== null;
  }

  override readRemoteJson<T>(rel: string): T | null {
    const out = this.tryGit(this.dir, ["show", `FETCH_HEAD:${rel}`], "show", true);
    if (out === null) return null;
    try { return JSON.parse(out) as T; } catch { return null; }
  }

  override resetToRemote(): boolean {
    if (!this.fetchRemote()) return false;
    this.tryGit(this.dir, ["rebase", "--abort"], "rebase --abort", true);
    if (this.tryGit(this.dir, ["reset", "-q", "--hard", "FETCH_HEAD"], "reset") === null) return false;
    this.tryGit(this.dir, ["clean", "-fdq"], "clean", true);
    return true;
  }

  override squash(message: string): boolean {
    let head: string;
    try {
      head = this.git(this.dir, ["rev-parse", "HEAD"]).trim();
      this.git(this.dir, ["add", "-A"]);
      const tree = this.git(this.dir, ["write-tree"]).trim();
      const commit = this.git(this.dir, ["commit-tree", tree, "-m", message]).trim();
      this.git(this.dir, ["reset", "-q", "--soft", commit]);
    } catch {
      this.log("git: échec de la compaction de l'historique (sans gravité)");
      return false;
    }
    // --force-with-lease : refusé si quelqu'un a poussé entre-temps (on ne lui écrase rien).
    const ok = this.tryGit(this.dir, ["push", "-q", `--force-with-lease=refs/heads/${this.branch}:${head}`, this.remote, `HEAD:refs/heads/${this.branch}`], "push (compaction)", true) !== null;
    if (ok) {
      this.tryGit(this.dir, ["reflog", "expire", "--expire=now", "--all"], "reflog", true);
    } else {
      // Compaction refusée : on revient à l'historique d'avant, rien n'est perdu.
      this.tryGit(this.dir, ["reset", "-q", "--soft", head], "reset", true);
      this.log("git: compaction de l'historique reportée");
    }
    return ok;
  }
}

/** Magasin en mémoire : rien n'est écrit sur disque (rejeu TEST, tests unitaires). */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  files = new Map<string, string>();
  syncs = 0;
  init(): void {}
  exists(rel: string): boolean { return this.files.has(rel); }
  readJson<T>(rel: string): T | null {
    const t = this.files.get(rel);
    if (t === undefined) return null;
    try { return JSON.parse(t) as T; } catch { return null; }
  }
  writeText(rel: string, text: string): void { this.files.set(rel, text); }
  writeJson(rel: string, value: unknown): void { this.files.set(rel, JSON.stringify(value) + "\n"); }
  remove(rel: string): void { this.files.delete(rel); }
  readJsonl<T>(rel: string): T[] { return parseJsonl<T>(this.files.get(rel) ?? "").rows; }
  appendJsonl(rel: string, rows: unknown[]): void {
    if (rows.length === 0) return;
    this.files.set(rel, (this.files.get(rel) ?? "") + rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  sync(_message: string): SyncResult { this.syncs++; return "ok"; }
  fetchRemote(): boolean { return true; }
  readRemoteJson<T>(rel: string): T | null { return this.readJson<T>(rel); }
  resetToRemote(): boolean { return true; }
  squash(_message: string): boolean { return true; }
}

/**
 * STORE_DIR défini → répertoire local sans git. Sinon → branche git `data` dans `<racine>/.data-branch`.
 */
export function createStore(o: { repoDir: string; storeDir?: string; log?: (line: string) => void; remote?: string; branch?: string }): Store {
  if (o.storeDir) return new DirStore(path.resolve(o.storeDir));
  return new GitStore({ repoDir: o.repoDir, dir: path.join(o.repoDir, ".data-branch"), log: o.log, remote: o.remote, branch: o.branch });
}

// ── Lecture / écriture typées ────────────────────────────────────────────────

export function readState(s: Store): RunnerState | null {
  const st = s.readJson<RunnerState>(FILES.state);
  return st && st.v === 1 && typeof st.cursor === "number" ? st : null;
}

export function readMarkets(s: Store): Map<string, MarketEntry> {
  const obj = s.readJson<Record<string, MarketEntry>>(FILES.markets) ?? {};
  return new Map(Object.entries(obj));
}

/** Une entrée par ligne : les diffs git restent petits quand un seul marché change. */
export function writeMarkets(s: Store, m: Map<string, MarketEntry>): void {
  const lines = [...m.entries()].map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  s.writeText(FILES.markets, `{\n${lines.join(",\n")}\n}\n`);
}

export const readFills = (s: Store): Fill[] => s.readJsonl<Fill>(FILES.fills);
export const readEvents = (s: Store): LedgerEvent[] => s.readJsonl<LedgerEvent>(FILES.events);
export const readAlerts = (s: Store): AlertRecord[] => s.readJsonl<AlertRecord>(FILES.alerts);
