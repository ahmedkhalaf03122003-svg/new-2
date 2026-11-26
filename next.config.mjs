/** @type {import('next').NextConfig} */
const nextConfig = {
  // @libsql/client يحمل روابط أصلية — يجب استثناؤه من التجميع (إلزامي للتوافق مع Vercel)
  serverExternalPackages: ["@libsql/client"],
  poweredByHeader: false,
};

export default nextConfig;
