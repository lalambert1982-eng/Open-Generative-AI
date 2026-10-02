import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so a stray lockfile in a parent directory cannot change it.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
};

export default nextConfig;
