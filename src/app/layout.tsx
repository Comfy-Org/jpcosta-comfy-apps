import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Comfy API Apps",
  description:
    "Sprite Generator, Virtual Try On, Hand Product Swap, Paparazzi Me, Background Removal, Open Product Swap, Open Unboxing, Pumpkin Carve, and Unrender on Comfy deployments.",
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
