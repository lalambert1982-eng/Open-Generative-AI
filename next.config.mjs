/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
  // ffmpeg-installer resolves its platform binary at runtime; bundling it breaks that lookup.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg'],
  outputFileTracingIncludes: {
    '/api/creator/[[...path]]': ['./node_modules/@ffmpeg-installer/**/*'],
  },
};

export default nextConfig;
