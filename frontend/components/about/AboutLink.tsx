// A link to /about for the app header (the shell decides where it goes). Server-safe: no hooks.
import Link from "next/link";

export function AboutLink({ className }: { className?: string }) {
  return (
    <Link
      href="/about"
      className={className ?? "rounded border border-zinc-300 px-2 py-0.5 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"}
    >
      About
    </Link>
  );
}
