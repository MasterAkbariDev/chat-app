import type { MetadataRoute } from "next";

/** The installable app: its name, icons and how it opens (its own window, not a browser tab). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chat",
    short_name: "Chat",
    description: "Private messaging for the people who matter most.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#0f1018",
    theme_color: "#0f1018",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
