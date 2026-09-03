import type { Metadata } from "next";
import Script from "next/script";
import { Instrument_Serif, Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const THEME_KEY = "stashdrop-theme";
// Runs before hydration so the page never flashes the wrong theme on load.
const setThemeBeforePaint = `
(function() {
  try {
    var t = localStorage.getItem("${THEME_KEY}");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
`;

const instrumentSerif = Instrument_Serif({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Stashdrop",
  description: "Everything you've kept, in one place.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${instrumentSans.variable} ${ibmPlexMono.variable}`}
      // The beforeInteractive theme script (below) sets data-theme on this
      // element before React hydrates, which will never match what the
      // server rendered (the server can't read the visitor's localStorage).
      // That's expected and intentional, not a bug — suppress the warning.
      suppressHydrationWarning
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">{setThemeBeforePaint}</Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
