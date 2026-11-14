import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // Saving a script version sends its whole text (up to 2 MB of UTF-8, more once escaped in the
    // action payload) through a server action; the 1 MB default would reject large scripts.
    serverActions: { bodySizeLimit: '5mb' },
  },
};

export default nextConfig;
