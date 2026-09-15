import type { Metadata, Viewport } from "next";
import { Baloo_2 } from "next/font/google";
import "./globals.css";

const baloo = Baloo_2({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

const DESCRIPCION =
  "Ahorro premiado sobre Stellar. Ponés plata en un pozo, el pozo genera en Blend, y cada ronda uno se lleva el rendimiento de todos. Tu capital queda intacto.";

export const metadata: Metadata = {
  title: "Zorrito",
  description: DESCRIPCION,
  metadataBase: new URL("https://stellar.zorrito.app"),
  openGraph: {
    title: "Zorrito — Ahorrá. Nadie pierde. Uno gana el rendimiento.",
    description: DESCRIPCION,
    images: [{ url: "/assets/zorritoimage.png", width: 1200, height: 646 }],
    locale: "es_AR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zorrito",
    description: DESCRIPCION,
    images: ["/assets/zorritoimage.png"],
  },
};

// Mobile-first: se entra desde el teléfono, desde el link que circula en el
// grupo. `viewport-fit` deja respirar el notch.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fd840e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`h-full antialiased ${baloo.variable}`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
