// Basic security headers for every response (pages, API routes and files under public/). There is deliberately no
// script/style Content-Security-Policy here: it could block Supabase calls or the self-hosted zxing WASM / pdf.js
// worker. The camera stays allowed for this site itself, because barcode scanning uses getUserMedia.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // The clinic's panel must never appear in search results (robots.txt and the root layout's metadata say the same).
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  poweredByHeader: false,
  transpilePackages: [
    '@dentos/shared',
    '@dentos/db',
    '@dentos/i18n',
    '@dentos/ai',
    '@dentos/ui',
  ],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
