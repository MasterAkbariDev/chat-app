import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree, Vazirmatn } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/themes";
import { PERFORMANCE_BOOTSTRAP_SCRIPT } from "@/lib/performance";

// Figtree is the UI face (open, friendly, very legible at small sizes — this
// app's readers range from kids to grandparents). Vazirmatn follows it in the
// font stack so Persian/Arabic text renders correctly per-glyph. Bricolage
// Grotesque is reserved for page titles and the sign-in wordmark.
const figtree = Figtree({
  subsets: ["latin", "latin-ext"],
  variable: "--font-figtree",
  display: "swap",
});

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  variable: "--font-vazirmatn",
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Chat", template: "%s · Chat" },
  description: "Private messaging for the people who matter most.",
  // Installed to an iPhone's home screen, it opens full screen like an app.
  appleWebApp: { capable: true, title: "Chat", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android Chrome: the on-screen keyboard shrinks the layout viewport (so
  // `100dvh` and the chat's composer move up with it) instead of overlaying
  // the page. iOS Safari ignores this — `useVisualViewport` covers it.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f4f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1018" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="daybreak"
      data-mode="dark"
      className={`${figtree.variable} ${vazirmatn.variable} ${bricolage.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT + PERFORMANCE_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
