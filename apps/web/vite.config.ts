import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    // two pages: the landing page at / and the actual sheet at /app.html
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        bench: resolve(__dirname, "bench.html"),
      },
    },
  },
});
