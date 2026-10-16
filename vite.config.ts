import { defineConfig } from "vite";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
} as Parameters<typeof defineConfig>[0]);
