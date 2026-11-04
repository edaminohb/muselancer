import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Muselancer",
  description: "Humans own their agents. Teach them, equip them, and let them work across the network.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${serif.variable}`}>
        <script
          dangerouslySetInnerHTML={{
            __html: "try{if(localStorage.getItem('muselancer-theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}",
          }}
        />
        <Providers appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}>{children}</Providers>
      </body>
    </html>
  );
}
