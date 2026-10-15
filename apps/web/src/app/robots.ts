import type { MetadataRoute } from "next";

// /robots.txt: crawling stays allowed on purpose. Search engines only honour the 'noindex' (meta tag in the root
// layout and the X-Robots-Tag header in next.config.js) on pages they may fetch; a 'Disallow: /' would hide that
// instruction and a linked URL could still be listed without a snippet.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
  };
}
