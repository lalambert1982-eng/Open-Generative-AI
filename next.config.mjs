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
  // Local browser verification only: proxy the Creator API to the fixture server
  // (scripts/replicate-ui-fixture-server.mjs). Inactive unless the variable is set
  // and never in production.
  async rewrites() {
    const fixture = process.env.NODE_ENV !== 'production' ? process.env.CREATOR_UI_FIXTURE_ORIGIN : '';
    if (!fixture || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(fixture)) return [];
    return { beforeFiles: [{ source: '/api/creator/:path*', destination: `${fixture}/api/creator/:path*` }] };
  },
};

export default nextConfig;
