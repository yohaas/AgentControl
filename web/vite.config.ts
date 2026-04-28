import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function isIgnorableWsError(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === "ECONNABORTED" || code === "ECONNRESET" || code === "EPIPE";
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/ws": {
        target: "ws://127.0.0.1:4317",
        ws: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (_proxyReq, _request, socket) => {
            const originalOn = socket.on.bind(socket);
            socket.on = ((event, listener) => {
              if (event !== "error" || typeof listener !== "function") {
                return originalOn(event, listener);
              }

              return originalOn(event, (error) => {
                if (isIgnorableWsError(error)) return socket;
                return listener(error);
              });
            }) as typeof socket.on;
          });
        }
      }
    }
  }
});
