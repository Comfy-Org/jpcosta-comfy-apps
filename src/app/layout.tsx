import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unrender",
  description: "Turn any final shot back into a grey clay playblast.",
  // A spinning clay cube. The GIF spins on its own in Firefox; the page spins it in other browsers.
  icons: {
    icon: [{ url: "/brand/favicon.gif", type: "image/gif" }],
    apple: [{ url: "/brand/apple-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
