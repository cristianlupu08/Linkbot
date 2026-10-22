import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LinkBot",
  description: "Telegram bot that turns voice notes into LinkedIn posts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
