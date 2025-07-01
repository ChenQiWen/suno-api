/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('rebrowser-playwright-core');
      config.externals.push('@playwright/browser-chromium');
      config.externals.push('ghost-cursor-playwright');
      config.externals.push('@2captcha/captcha-solver');
    }
    return config;
  },
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
  },
};  

export default nextConfig;
