import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // El repo tiene un package.json en la raíz (scripts de cargo), así que Next
  // podría inferir mal dónde empieza el workspace. Lo fijamos acá.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
