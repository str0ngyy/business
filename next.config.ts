import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Явно включаем строгие проверки на сборке: ошибка типов должна ломать билд,
  // а не уезжать в продакшн.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
