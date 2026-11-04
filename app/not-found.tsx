import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/States";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[560px] flex-1 px-5 py-12">
        <EmptyState
          icon={<Compass className="size-6" />}
          title="We can’t find that page"
          action={<LinkButton href="/">Back to home</LinkButton>}
        >
          The link may be mistyped or no longer exists.
        </EmptyState>
      </main>
      <SiteFooter />
    </>
  );
}
