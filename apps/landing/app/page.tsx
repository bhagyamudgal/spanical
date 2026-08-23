import { Hero } from "@/components/sections/hero";
import { Features } from "@/components/sections/features";
import { Installation } from "@/components/sections/installation";
import { HowItWorks } from "@/components/sections/how-it-works";
import { BGPattern } from "@/components/ui/bg-pattern";

export default function Home() {
    return (
        <div className="relative min-h-screen">
            <BGPattern
                variant="dots"
                mask="fade-edges"
                size={32}
                fill="oklch(0.72 0.115 185 / 0.06)"
            />
            <main id="main-content">
                <Hero />
                <Features />
                <Installation />
                <HowItWorks />
            </main>
        </div>
    );
}
