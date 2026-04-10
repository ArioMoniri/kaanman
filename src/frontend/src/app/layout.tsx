import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
