import type { NextConfig } from "next";

// Server actions carry dropped files as data URLs, so the default 1MB body
// cap is too small — allow 10MB by default, overridable via env.
const nextConfig: NextConfig = {
  devIndicators: false,
  // pdf-parse pulls in pdf.js, which breaks when bundled — load it from
  // node_modules at runtime instead, like plain Node.
  serverExternalPackages: ["pdf-parse"],
  experimental: {
    serverActions: {
      bodySizeLimit: (process.env.SERVER_ACTIONS_BODY_SIZE_LIMIT || "10mb") as `${number}${"k" | "K" | "m" | "M" | "g" | "G" | "t" | "T" | "p" | "P"}${"b" | "B"}`,
    },
  },
};

export default nextConfig;
