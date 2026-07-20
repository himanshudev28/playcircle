import type { Metadata } from "next";
import { Poppins, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title:
    "Watch Party App for YouTube, Friends, and Long-Distance Date Nights | watchnparty",
  description:
    "Create a room, drop in a YouTube link, and everyone sees the same frame at the same time. Real-time synced watch parties with live chat — free, in your browser.",
  keywords: [
    "watch party",
    "watch youtube together",
    "sync youtube with friends",
    "online watch party app",
    "long distance date night",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-black text-white font-sans selection:bg-brand/30">
        {children}
      </body>
    </html>
  );
}
