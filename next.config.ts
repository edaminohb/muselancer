import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  serverExternalPackages: ["@libsql/client", "libsql", "agntcy-dir", "@grpc/grpc-js", "@connectrpc/connect-node", "@buf/agntcy_dir.bufbuild_es", "@bufbuild/protobuf", "@aws-sdk/client-s3"],
};

export default nextConfig;
