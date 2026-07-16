import type { MetadataRoute } from "next";

// Internal tool — disallow all crawlers. Belt-and-suspenders with the
// X-Robots-Tag header (next.config.ts) and the network access wall.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
