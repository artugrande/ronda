import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zorrito",
  description: "Ahorro premiado. Nadie pierde, uno gana el rendimiento.",
};

// Mobile-first: se entra desde el teléfono, desde el link que circula en el
// grupo. `viewport-fit` deja respirar el notch.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
