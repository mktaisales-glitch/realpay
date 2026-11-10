import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    sequence: { shuffle: true },
    include: ["src/**/*.test.ts"],
  },
});
