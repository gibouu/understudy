import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz", "SOFT", "WONK"] });
const sourceSerif = Source_Serif_4({ variable: "--font-text", subsets: ["latin"], axes: ["opsz"] });
const jetbrains = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Understudy",
  description: "Film a person doing a task once. Understudy turns the clip into a robot program, asks what the camera could not see, and rehearses it on a simulated SO-101 arm, on Earth and in orbit.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${sourceSerif.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="border-b">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3 sm:px-6">
            <Link href="/" className="display text-2xl font-semibold text-ink-deep">
              Understudy
            </Link>
            <span className="flex gap-5 text-[15px]">
              <Link href="/space" className="underline-offset-4 hover:text-accent-text hover:underline">
                Space showcase
              </Link>
              <Link href="/try" className="underline-offset-4 hover:text-accent-text hover:underline">
                Film your own
              </Link>
            </span>
          </nav>
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
        <footer className="border-t">
          <p className="mx-auto max-w-6xl px-4 py-5 text-sm text-muted sm:px-6">
            Built for the Nebius × NVIDIA Global AI Hackathon 2026, Physical AI track. Models: Nemotron on Nebius Token Factory. The ISS examples were recorded on Nemotron 3 Nano and Super, which leave Token Factory serverless on 9 Nov 2026; your own clips run on Nemotron 3.5 Lightning and Super VL in their place. Simulator: MuJoCo in your browser. Apache-2.0,{" "}
            <a className="underline underline-offset-2 hover:text-accent-text" href="https://github.com/gibouu/understudy">
              source on GitHub
            </a>
            .
          </p>
        </footer>
      </body>
    </html>
  );
}
