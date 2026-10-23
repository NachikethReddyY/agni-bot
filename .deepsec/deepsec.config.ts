import { defineConfig } from "deepsec/config";
import { generatedMatchersPlugin } from "./generated-matchers.js";

export default defineConfig({
  ai: {"mode":"gateway","provider":"vercel"}, // <deepsec:model-route>
  projects: [
    { id: "agni-bot", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [generatedMatchersPlugin],
});
