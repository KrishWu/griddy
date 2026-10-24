import type { Metadata } from "next";

import { AboutPage } from "@/components/about/AboutPage";

// Server component with no dynamic APIs, so `next build` prerenders it (works with output: "export").
export const metadata: Metadata = {
  title: "About Griddy",
  description: "What Griddy does, how to use it, the math behind every number, data sources, team and limitations.",
};

export default function About() {
  return <AboutPage />;
}
