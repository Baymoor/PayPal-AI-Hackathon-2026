import { FlaskConical } from "lucide-react";
import { HandNote, Sticker } from "@/components/ui/HandNote";
import { InvitationHero } from "@/components/ui/Illustrations";
import { PhoneFrame } from "@/components/ui/PhoneFrame";

/** One money row of the miniature invitation; mirrors the real invitation's money card. */
function PreviewRow({ label, sub, value, strong }: { label: string; sub?: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <span className={strong ? "font-semibold" : undefined}>
        {label}
        {sub && <span className="block text-ink-muted">{sub}</span>}
      </span>
      <span className={`font-money ${strong ? "text-[19px]" : "text-[17px]"}`}>{value}</span>
    </div>
  );
}

/**
 * Landing hero: the product's own invitation screen in a phone, instead of a stock-style illustration.
 * A static picture of the UI (not a live form), so its contents are hidden from screen readers and the
 * caption says what it is. The sticker and the margin note only repeat the page's own copy.
 */
export function InvitationPreview() {
  return (
    <figure className="mx-auto flex w-full max-w-[340px] flex-col items-center gap-5">
      <div className="relative">
        <PhoneFrame className="-rotate-[4deg] motion-reduce:rotate-0">
          <InvitationHero className="h-[104px] shrink-0" />
          <div className="flex flex-col gap-2.5 px-[18px] pt-3.5 text-[12px] leading-[16px] text-ink">
            <p className="flex items-center justify-center gap-1 text-[10px] text-ink-muted">
              <FlaskConical className="size-3" />
              Simulated payments and AI · no real money
            </p>
            <p className="text-center font-display text-[30px] leading-[34px]">You&apos;re invited.</p>
            <p className="text-center font-display text-[17px] leading-[22px]">Maya&apos;s birthday karaoke</p>
            <p className="text-center text-ink-muted">Friday 19:00 · The Sound Room · up to 10</p>
            <div className="rounded-[16px] border border-line bg-surface px-3.5 py-1">
              <PreviewRow label="Fixed room total" sub="6 attendees · 5 paying" value="$100" />
              <PreviewRow label="Your maximum" value="$20" />
              <PreviewRow label="Estimated share" value="$20" strong />
            </div>
            <p className="text-[11px] text-ink-muted">Commit by Thursday 18:00 · 1d 7h left</p>
            <div className="space-y-1">
              <p className="text-[11px]">4 of 5 payers committed</p>
              <div className="h-[7px] rounded-pill bg-track">
                <div className="h-[7px] w-4/5 rounded-pill bg-coral-600" />
              </div>
            </div>
            <span className="mt-1 flex h-10 items-center justify-center rounded-pill bg-coral-600 text-[13px] font-semibold text-white">
              Review &amp; authorize $20
            </span>
          </div>
        </PhoneFrame>
        {/* Sits over the empty foot of the screen, so it never covers the "simulated" label or an amount. */}
        <Sticker className="-right-5 bottom-[84px] rotate-[5deg] sm:-right-9">Nobody is charged yet</Sticker>
        {/* Only where the hero is two columns: the note sits in the gap beside the phone. */}
        <HandNote arrow="right" className="bottom-[112px] right-full mr-1 hidden w-[136px] xl:block">
          A hold, not a charge.
        </HandNote>
      </div>
      <figcaption className="text-center text-small text-ink-muted">Sample invitation from the demo. No real money.</figcaption>
    </figure>
  );
}
