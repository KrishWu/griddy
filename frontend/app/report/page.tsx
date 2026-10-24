import type { Metadata } from "next";

import { ReportView } from "@/components/builder/ReportView";

export const metadata: Metadata = { title: "GridForge report" };

export default function ReportPage() {
  return <ReportView />;
}
