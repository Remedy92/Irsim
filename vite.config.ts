import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173 },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Heavy direct-coax physics files contend on CI's 2-vCPU runners when run in parallel,
    // slowing wall-clock enough to flake calibrated gates (PUSHABILITY, chirality, pullback).
    fileParallelism: false
  }
});
