/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: [
    '@dentos/shared',
    '@dentos/db',
    '@dentos/i18n',
    '@dentos/ai',
    '@dentos/ui',
  ],
};

module.exports = nextConfig;
