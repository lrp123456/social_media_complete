/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: '/settings/selectors', destination: '/settings', permanent: true },
    ];
  },
};

module.exports = nextConfig;
