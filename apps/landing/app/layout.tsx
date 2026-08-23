import type { Metadata } from "next";
// eslint-disable-next-line camelcase -- next/font exports use font family names with underscores
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
    subsets: ["latin"],
    variable: "--font-sans",
    weight: ["300", "400", "500", "600", "700"],
    display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
    subsets: ["latin"],
    variable: "--font-mono",
    display: "swap",
});

const FAVICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230D9488'/%3E%3Cpath d='M8 11l6 5-6 5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='16' y1='21' x2='24' y2='21' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
    icons: {
        icon: [{ url: FAVICON }],
    },
    title: "spanical - Code Insights From Git History",
    description:
        "Local-first code-insights CLI. Point it at any git repository and it reports how much was built, when, by whom, and where the codebase is getting risky.",
    keywords: [
        "code insights",
        "git analytics",
        "hotspots",
        "bus factor",
        "code ownership",
        "churn",
        "cli tool",
        "engineering metrics",
    ],
    authors: [{ name: "Bhagya Mudgal" }],
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className="dark" suppressHydrationWarning>
            <body
                className={`${ibmPlexSans.variable} ${jetbrainsMono.variable} font-sans antialiased`}
            >
                <ThemeProvider defaultTheme="dark">
                    <a
                        href="#main-content"
                        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
                    >
                        Skip to content
                    </a>
                    <Header />
                    {children}
                    <Footer />
                </ThemeProvider>
            </body>
        </html>
    );
}
