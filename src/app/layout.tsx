import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
// JetBrains Mono is self-hosted from npm: next/font/google needs fonts.googleapis.com at build time.
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './globals.css';

export const metadata: Metadata = { title: 'Armadillo' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
