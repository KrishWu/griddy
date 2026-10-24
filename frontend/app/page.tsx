import { AppShell } from "@/components/shell/AppShell";
import { GridForgeProvider } from "@/lib/store";

export default function Home() {
  return (
    <GridForgeProvider>
      <AppShell />
    </GridForgeProvider>
  );
}
