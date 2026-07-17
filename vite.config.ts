import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The local DICOM worker lazily imports optional lossless codecs. ES workers preserve module
  // code-splitting while keeping those decoder bytes out of the public-demo startup path.
  worker: { format: "es" },
  server: { host: "127.0.0.1", port: 5173 },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Heavy direct-coax physics files contend on CI runners when run in parallel; serialize files.
    fileParallelism: false,
    // Default 5s is far below the wall-clock cost of shipped coax navigation gates on CI hardware.
    testTimeout: 180_000
  }
});
