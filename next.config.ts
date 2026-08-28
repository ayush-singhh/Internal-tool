import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle so the container ships without node_modules.
  output: "standalone",
  experimental: {
    // A carrier spreadsheet is sent to the server as one payload for preview and
    // commit; the 1 MB default cuts off at roughly a thousand rows.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
