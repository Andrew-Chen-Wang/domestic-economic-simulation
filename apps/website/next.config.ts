import * as path from "node:path"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@api/internal", "@econsim/engine"],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
}

export default nextConfig
