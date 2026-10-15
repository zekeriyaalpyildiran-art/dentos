import type { MetadataRoute } from "next";

// /robots.txt: the clinic's panel is not for search engines; every crawler is asked to stay out.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
