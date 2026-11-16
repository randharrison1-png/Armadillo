import type { Metadata } from 'next';
import { connection } from 'next/server';
import { GeistSans } from 'geist/font/sans';
// JetBrains Mono is self-hosted from npm: next/font/google needs fonts.googleapis.com at build time.
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './globals.css';

export const metadata: Metadata = { title: 'Armadillo' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render every page per request: the Content-Security-Policy nonce (src/proxy.ts) can only be
  // stamped on scripts Next renders for a live request, never on build-time static output (which
  // would include the 404 page).
  await connection();
  return (
    <html lang="en" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
