// Bail (lease) et relais entre deux runs : un seul run envoie des alertes à un instant donné.
//
//  - `state.lease = {run_id, acquired_ts, heartbeat_ts, released, handover_wanted_ts}` ;
//  - un run qui démarre : bail absent, libéré ou mort (battement > LEASE_STALE_S) → il le prend ;
//    bail vivant + relais demandé → il se met en attente (successeur) et l'annonce dans state/handover.json ;
//    bail vivant sans relais demandé (chien de garde) → il s'arrête tout de suite ;
//  - le détenteur demande un successeur à MAX_RUN_S − HANDOVER_BEFORE_END_S, continue jusqu'à voir
//    handover.json (ou jusqu'à MAX_RUN_S), puis libère le bail.
// Les décisions sont des fonctions pures ; seul `dispatchSuccessor` fait du réseau.

import { execFileSync } from "node:child_process";
import type { Config } from "../core/config.ts";
import type { Handover, Lease } from "../core/types.ts";
import type { FetchLike } from "./polymarket.ts";

export type StartDecision = "acquire" | "standby" | "exit";

export function leaseAlive(lease: Lease | null | undefined, now: number, staleS: number): boolean {
  return !!lease && !lease.released && now - lease.heartbeat_ts <= staleS;
}

/** Que doit faire un run qui démarre (ou un successeur en attente qui réévalue la situation) ? */
export function decideAtStart(
  lease: Lease | null | undefined,
  handover: Handover | null | undefined,
  now: number,
  runId: string,
  cfg: Pick<Config, "LEASE_STALE_S" | "SUCCESSOR_MAX_WAIT_S">,
): StartDecision {
  if (!leaseAlive(lease, now, cfg.LEASE_STALE_S)) return "acquire";
  const l = lease as Lease;
  if (l.run_id === runId) return "acquire";
  if (l.handover_wanted_ts === null) return "exit";
  // Relais demandé : un seul successeur. Si un autre run s'est déjà annoncé récemment, on lui laisse la place.
  const other = handover && handover.run_id !== runId && handover.run_id !== l.run_id
    && handover.ready_ts >= l.handover_wanted_ts && now - handover.ready_ts <= cfg.SUCCESSOR_MAX_WAIT_S;
  return other ? "exit" : "standby";
}

export function newLease(runId: string, now: number): Lease {
  return { run_id: runId, acquired_ts: now, heartbeat_ts: now, released: false, handover_wanted_ts: null };
}

/** Le détenteur doit-il demander son successeur maintenant ? */
export function handoverDue(startedTs: number, now: number, lease: Lease, cfg: Pick<Config, "MAX_RUN_S" | "HANDOVER_BEFORE_END_S">): boolean {
  return lease.handover_wanted_ts === null && now - startedTs >= cfg.MAX_RUN_S - cfg.HANDOVER_BEFORE_END_S;
}

/** Le successeur est-il prêt (handover.json postérieur à la demande, écrit par un autre run) ? */
export function successorReady(lease: Lease, handover: Handover | null | undefined): boolean {
  return !!handover && lease.handover_wanted_ts !== null && handover.run_id !== lease.run_id && handover.ready_ts >= lease.handover_wanted_ts;
}

/** Le run doit-il s'arrêter (durée maximale atteinte) ? */
export function runExpired(startedTs: number, now: number, cfg: Pick<Config, "MAX_RUN_S">): boolean {
  return now - startedTs >= cfg.MAX_RUN_S;
}

/**
 * Lance le run suivant du workflow (`workflow_dispatch`). Nécessite GITHUB_TOKEN avec `actions: write`.
 * Le jeton n'apparaît dans aucun message. Renvoie false si le lancement n'a pas pu être fait
 * (le chien de garde `schedule` prendra alors le relais).
 */
export async function dispatchSuccessor(o: {
  repo: string | undefined; token: string | undefined; ref?: string; workflow?: string;
  fetchImpl?: FetchLike; log: (line: string) => void;
}): Promise<boolean> {
  const workflow = o.workflow ?? "monitor.yml";
  const ref = o.ref ?? "main";
  if (!o.repo || !o.token) { o.log("relais: GITHUB_REPOSITORY ou GITHUB_TOKEN absent, successeur non lancé"); return false; }
  const f: FetchLike = o.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await f(`https://api.github.com/repos/${o.repo}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json", "User-Agent": "cs2-wallet-monitor/1.0",
        },
        body: JSON.stringify({ ref, inputs: { mode: "run" } }),
        signal: ac.signal,
      });
      if (res.ok) { o.log("relais: successeur lancé (workflow_dispatch)"); return true; }
      o.log(`relais: l'API GitHub a répondu HTTP ${res.status}, essai avec gh`);
    } finally { clearTimeout(timer); }
  } catch {
    o.log("relais: API GitHub injoignable, essai avec gh");
  }
  try {
    execFileSync("gh", ["workflow", "run", workflow, "--ref", ref, "-f", "mode=run", "-R", o.repo], {
      stdio: "ignore", timeout: 30000, env: { ...process.env, GH_TOKEN: o.token },
    });
    o.log("relais: successeur lancé (gh workflow run)");
    return true;
  } catch {
    o.log("relais: échec du lancement du successeur (le chien de garde prendra le relais)");
    return false;
  }
}
