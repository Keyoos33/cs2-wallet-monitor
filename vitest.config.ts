import { defineConfig } from "vitest/config";

// Les tests du magasin git lancent de vrais processus git : on laisse de la marge sur les machines lentes.
export default defineConfig({ test: { testTimeout: 30000, include: ["test/**/*.test.ts"] } });
