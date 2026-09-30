import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // La ruta lee los datos del reto desde disco: hay que incluirlos en el bundle serverless.
  outputFileTracingIncludes: {
    "/api/analyze": ["./docs/incident-command/**/*"],
  },
};

export default nextConfig;
