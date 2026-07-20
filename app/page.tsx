import { Intro } from "@/components/landing/Intro";
import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { Stats } from "@/components/landing/Stats";
import { UseCases } from "@/components/landing/UseCases";
import { Steps } from "@/components/landing/Steps";
import { PreFaq } from "@/components/landing/PreFaq";
import { Features } from "@/components/landing/Features";
import { RoomPreview } from "@/components/landing/RoomPreview";
import { BigFaq } from "@/components/landing/BigFaq";
import { Footer } from "@/components/landing/Footer";

export default function Home() {
  return (
    <>
      <Intro />
      <Nav />
      <main>
        <Hero />
        <Stats />
        <UseCases />
        <Steps />
        <PreFaq />
        <Features />
        <RoomPreview />
        <BigFaq />
      </main>
      <Footer />
    </>
  );
}
