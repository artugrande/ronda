import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ronda",
  description: "La vaquita de siempre, pero el contrato guarda la plata",
};

// Mobile-first: la ronda se arma en el grupo de WhatsApp, se entra desde el
// teléfono. `viewport-fit` deja respirar el notch.
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
