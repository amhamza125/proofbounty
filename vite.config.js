import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ProofBounty reads and writes go straight to the Bradbury node RPC via
// genlayer-js — no explorer API proxy is needed (unlike GrantFlow's
// activity feed), so the config stays minimal.
export default defineConfig({
  plugins: [react()],
});
