import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: "CerebraLink",
  description: "AI-powered medical assistant for clinicians",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
