import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Class Royale",
  description: "A saner interface for your degree progress and requirements.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
