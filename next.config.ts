import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The carousel renderer reads these fonts from disk at runtime, so ship them with the webhook.
  outputFileTracingIncludes: {
    "/api/telegram": ["./assets/fonts/**"],
  },
};

export default nextConfig;
