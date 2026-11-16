import type { NextConfig } from 'next';
import { staticSecurityHeaders } from './src/server/security/headers';

const nextConfig: NextConfig = {
  experimental: {
    // Saving a script version sends its whole text (up to 2 MB of UTF-8, more once escaped in the
    // action payload) through a server action; the 1 MB default would reject large scripts.
    serverActions: { bodySizeLimit: '5mb' },
  },
  async headers() {
    // Static security headers on every response. The Content-Security-Policy is per request (it
    // carries a nonce), so src/proxy.ts sets it instead.
    return [{ source: '/:path*', headers: staticSecurityHeaders({ production: process.env.NODE_ENV === 'production' }) }];
  },
};

export default nextConfig;
