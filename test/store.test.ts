import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MarketEntry } from "../src/core/types.ts";
import { createStore, FILES, MemoryStore, readMarkets, writeMarkets } from "../src/runner/store.ts";
import { synthMarket } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cs2mon-store-")); dirs.push(d); return d; };

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("magasin local (STORE_DIR, sans git)", () => {
  it("écrit, relit, ajoute en fin de fichier ; sync est sans effet", () => {
    const s = createStore({ repoDir: "/nonexistent", storeDir: tmp() });
    s.init();
    expect(s.kind).toBe("dir");
    expect(s.readJson(FILES.state)).toBeNull();
    s.writeJson(FILES.state, { v: 1 });
    expect(s.readJson(FILES.state)).toEqual({ v: 1 });
    s.appendJsonl(FILES.fills, [{ i: 0 }, { i: 1 }]);
    s.appendJsonl(FILES.fills, [{ i: 2 }]);
    s.appendJsonl(FILES.fills, []);
    expect(s.readJsonl(FILES.fills)).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(s.sync("x")).toBe("ok");
    s.remove(FILES.state);
    expect(s.exists(FILES.state)).toBe(false);
  });

  it("fin de fichier tronquée (écriture interrompue) : la ligne incomplète est écartée et le fichier réparé", () => {
    const dir = tmp();
    const s = createStore({ repoDir: "/nonexistent", storeDir: dir });
    s.init();
    s.appendJsonl(FILES.fills, [{ i: 0, o: "é" }, { i: 1 }]);
    fs.appendFileSync(path.join(dir, FILES.fills), '{"i":2,"transaction_ha');
    expect(s.readJsonl(FILES.fills)).toEqual([{ i: 0, o: "é" }, { i: 1 }]);
    s.appendJsonl(FILES.fills, [{ i: 2 }]);
    expect(s.readJsonl(FILES.fills)).toEqual([{ i: 0, o: "é" }, { i: 1 }, { i: 2 }]);
  });

  it("markets.json : une entrée par ligne, relecture fidèle", () => {
    const s = new MemoryStore();
    const m = new Map<string, MarketEntry>([["0xa", synthMarket("0xa")], ["0xb", synthMarket("0xb", { resolved: true, closed: true, prices: [1, 0] })]]);
    writeMarkets(s, m);
    expect(s.files.get(FILES.markets)!.trim().split("\n")).toHaveLength(4);
    expect([...readMarkets(s).entries()]).toEqual([...m.entries()]);
    writeMarkets(s, new Map());
    expect(readMarkets(s).size).toBe(0);
  });
});

describe.skipIf(!hasGit)("magasin git (branche `data`, dépôt distant local de test)", () => {
  /** Dépôt distant nu + clone superficiel de `main`, comme actions/checkout. */
  function world(): { remote: string; clone: () => string } {
    const root = tmp();
    const remote = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q");
    fs.writeFileSync(path.join(seed, "README.md"), "code\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", remote, "HEAD:refs/heads/main");
    let n = 0;
    const clone = (): string => {
      const dir = path.join(root, `work${++n}`);
      git(root, "clone", "-q", "--depth=1", "--branch", "main", `file://${remote}`, dir);
      return dir;
    };
    return { remote, clone };
  }
  const logOf = (remote: string): string[] => git(remote, "log", "--format=%s", "data").trim().split("\n");

  it("premier démarrage : crée la branche orpheline ; un second clone la retrouve", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    expect(a.kind).toBe("git");
    a.writeJson(FILES.state, { v: 1, cursor: 5 });
    a.appendJsonl(FILES.fills, [{ i: 0 }]);
    expect(a.sync("premier")).toBe("ok");
    expect(logOf(w.remote)).toEqual(["premier", "data: initialisation"]);
    // La branche data est orpheline : aucun fichier du code.
    expect(git(w.remote, "ls-tree", "-r", "--name-only", "data").trim().split("\n").sort()).toEqual(["README.md", FILES.fills, FILES.state].sort());
    const b = createStore({ repoDir: w.clone() });
    b.init();
    expect(b.readJson(FILES.state)).toEqual({ v: 1, cursor: 5 });
    expect(b.readJsonl(FILES.fills)).toEqual([{ i: 0 }]);
    expect(a.sync("rien à pousser")).toBe("ok");
    expect(logOf(w.remote)).toHaveLength(2);
  });

  it("push rejeté (un autre écrivain a ajouté un fichier) : rebase puis nouvel essai, rien n'est perdu", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    a.writeJson(FILES.state, { v: 1, n: 1 });
    expect(a.sync("a1")).toBe("ok");
    const b = createStore({ repoDir: w.clone() });
    b.init();
    b.writeJson(FILES.handover, { run_id: "B", ready_ts: 1 });
    expect(b.sync("b: prêt")).toBe("ok");
    a.writeJson(FILES.state, { v: 1, n: 2 });
    a.appendJsonl(FILES.fills, [{ i: 0 }]);
    expect(a.sync("a2")).toBe("ok");
    expect(a.readJson(FILES.handover)).toEqual({ run_id: "B", ready_ts: 1 });
    expect(logOf(w.remote)[0]).toBe("a2");
    // B voit l'état d'A sans toucher à ses fichiers, puis se recale.
    expect(b.fetchRemote()).toBe(true);
    expect(b.readRemoteJson(FILES.state)).toEqual({ v: 1, n: 2 });
    expect(b.readJson(FILES.state)).toEqual({ v: 1, n: 1 });
    expect(b.resetToRemote()).toBe(true);
    expect(b.readJson(FILES.state)).toEqual({ v: 1, n: 2 });
  });

  it("deux écrivains sur le même fichier : « conflict », jamais d'écrasement silencieux", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    a.writeJson(FILES.state, { v: 1, who: "base" });
    a.sync("base");
    const b = createStore({ repoDir: w.clone() });
    b.init();
    b.writeJson(FILES.state, { v: 1, who: "B" });
    expect(b.sync("b")).toBe("ok");
    a.writeJson(FILES.state, { v: 1, who: "A" });
    expect(a.sync("a")).toBe("conflict");
    expect(git(w.remote, "show", `data:${FILES.state}`)).toContain('"B"');
    expect(a.resetToRemote()).toBe(true);
    expect(a.readJson(FILES.state)).toEqual({ v: 1, who: "B" });
    a.writeJson(FILES.state, { v: 1, who: "A2" });
    expect(a.sync("a2")).toBe("ok");
  });

  it("dépôt distant injoignable : « failed », les commits locaux partent au prochain essai", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    fs.renameSync(w.remote, `${w.remote}.down`);
    a.writeJson(FILES.state, { v: 1, n: 1 });
    expect(a.sync("hors ligne")).toBe("failed");
    fs.renameSync(`${w.remote}.down`, w.remote);
    a.writeJson(FILES.heartbeat, { ts: 1 });
    expect(a.sync("de retour")).toBe("ok");
    expect(logOf(w.remote).slice(0, 2)).toEqual(["de retour", "hors ligne"]);
  });

  it("compaction : l'historique est réduit à un commit, le contenu est identique, les autres clones suivent", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    for (let k = 0; k < 5; k++) { a.writeJson(FILES.state, { v: 1, k }); a.sync(`c${k}`); }
    const b = createStore({ repoDir: w.clone() });
    b.init();
    const tree = git(w.remote, "rev-parse", "data^{tree}").trim();
    expect(a.squash("compaction")).toBe(true);
    expect(logOf(w.remote)).toEqual(["compaction"]);
    expect(git(w.remote, "rev-parse", "data^{tree}").trim()).toBe(tree);
    a.writeJson(FILES.state, { v: 1, k: 99 });
    expect(a.sync("après")).toBe("ok");
    expect(b.resetToRemote()).toBe(true);
    expect(b.readJson(FILES.state)).toEqual({ v: 1, k: 99 });
    // Un écrivain resté sur l'ancien historique n'écrase rien : conflit, puis recalage.
    const c = createStore({ repoDir: w.clone() });
    c.init();
    expect(c.squash("compaction 2")).toBe(true);
    a.writeJson(FILES.reconcileRequest, { ts: 1 });
    expect(a.sync("demande")).not.toBe("ok");
    expect(a.resetToRemote()).toBe(true);
    a.writeJson(FILES.reconcileRequest, { ts: 1 });
    expect(a.sync("demande")).toBe("ok");
  });

  it("compaction refusée si quelqu'un a poussé entre-temps (force-with-lease) : rien n'est écrasé", () => {
    const w = world();
    const a = createStore({ repoDir: w.clone() });
    a.init();
    a.writeJson(FILES.state, { v: 1 });
    a.sync("a");
    const b = createStore({ repoDir: w.clone() });
    b.init();
    b.writeJson(FILES.reconcileRequest, { ts: 7 });
    expect(b.sync("demande")).toBe("ok");
    expect(a.squash("compaction")).toBe(false);
    expect(git(w.remote, "show", `data:${FILES.reconcileRequest}`)).toContain("7");
    a.writeJson(FILES.heartbeat, { ts: 2 });
    expect(a.sync("battement")).toBe("ok");
    expect(a.readJson(FILES.reconcileRequest)).toEqual({ ts: 7 });
  });
});
