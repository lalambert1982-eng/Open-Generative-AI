import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so a stray lockfile in a parent directory cannot change it.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
  // ffmpeg-installer resolves its platform binary at runtime; bundling it breaks that lookup.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg'],
  outputFileTracingIncludes: {
    '/api/creator/[[...path]]': ['./node_modules/@ffmpeg-installer/**/*'],
  },
};

export default nextConfig;
