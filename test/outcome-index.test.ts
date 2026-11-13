import { describe, it, expect } from "vitest";
import { outcomeIndexFor } from "../src/core/positions.ts";

// Cas réel du 13/11/2026 : une ligne TRADE de l'API v2 avec outcome_index = 999
// (Map 1 Rounds Handicap: Team Falcons (-3.5) vs G2 (+3.5), issue achetée « G2 »).
describe("outcomeIndexFor", () => {
  const meta = { tokenIds: ["tokFalcons", "tokG2"] };
  it("le token fait foi quand l'API renvoie 999", () => expect(outcomeIndexFor(meta, "tokG2", 999)).toBe(1));
  it("corrige aussi un index contradictoire", () => expect(outcomeIndexFor(meta, "tokFalcons", 1)).toBe(0));
  it("repli sur l'index de l'API si le token est inconnu ou le marché absent", () => {
    expect(outcomeIndexFor(meta, "autre", 1)).toBe(1);
    expect(outcomeIndexFor(undefined, "tokG2", 0)).toBe(0);
  });
});
