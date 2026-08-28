import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // A carrier spreadsheet is sent to the server as one payload for preview and
    // commit; the 1 MB default cuts off at roughly a thousand rows.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
