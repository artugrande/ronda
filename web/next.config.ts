import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // El repo tiene un package.json en la raíz (scripts de cargo), así que Next
  // podría inferir mal dónde empieza el workspace. Lo fijamos acá.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  // El dominio es stellar.zorrito.app; la URL de Vercel que quedó en algún
  // lado redirige ahí, con la ruta.
  async redirects() {
    return [
      {
        source: "/:ruta*",
        has: [{ type: "host", value: "zorritostellar.vercel.app" }],
        destination: "https://stellar.zorrito.app/:ruta*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
