import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { SettingsProvider } from "@/lib/settings";
import { GridForgeProvider } from "@/lib/store";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Griddy",
  description: "Plan power plants, energy storage and grid connections for growing demand. Compare costs, carbon and resilience.",
};

// Applies the saved theme, text size and reduced motion before first paint, so Dark / Mixed / Large
// don't flash. Mirrors readStored() + applyToDocument() in lib/settings.tsx (a client module, so the
// script can't be imported from there into this server layout). Nothing saved: the old "griddy:theme"
// key, then the OS preference. Each storage read has its own try: blocked storage throws, and then
// the OS preference still applies, as readStored() falls back to "system" (no light-then-dark flash).
const SETTINGS_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var s=null,t=null;try{s=JSON.parse(localStorage.getItem('griddy:settings')||'null')}catch(e){}
if(s){t=s.theme}else{try{t=localStorage.getItem('griddy:theme')}catch(e){}}
if(t!=='light'&&t!=='dark'&&t!=='mixed'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
d.dataset.theme=t;
if(s&&(s.textSize==='small'||s.textSize==='large'))d.dataset.textSize=s.textSize;
if(s&&typeof s.reduceMotion==='boolean'?s.reduceMotion:matchMedia('(prefers-reduced-motion: reduce)').matches)d.dataset.reduceMotion='';
}catch(e){d.dataset.theme='light'}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Theme, text size and reduced motion from the saved settings before first paint (no flash). */}
      <head><script dangerouslySetInnerHTML={{ __html: SETTINGS_INIT_SCRIPT }} /></head>
      <body className="min-h-full flex flex-col">
        {/* In the layout (not the page) so state survives navigation, e.g. to /report. */}
        {/* Settings too, so /about and /report share the theme and display choices. */}
        <SettingsProvider>
          <GridForgeProvider>{children}</GridForgeProvider>
        </SettingsProvider>
      </body>
    </html>
  );
}
