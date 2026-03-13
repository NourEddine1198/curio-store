/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow images from your future CDN or storage
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
