import { cn } from "./cn";

/**
 * A generic, realistic phone for showing a picture of the app: metal frame, black bezel, side buttons,
 * punch-hole camera, status bar and home indicator. Deliberately not any one maker's phone.
 * Decorative: whatever it frames is a picture of the UI, so the whole device is hidden from assistive tech.
 * The greys below are the device itself, not brand colours, which is why they are not theme tokens.
 */
export function PhoneFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative h-[658px] w-[316px] rounded-[50px] p-[3px]",
        "bg-[linear-gradient(135deg,#9aa0ab_0%,#2c3039_16%,#111318_50%,#2c3039_84%,#7d848f_100%)]",
        "shadow-[0_1px_2px_rgb(8_12_22/0.4),0_14px_24px_rgb(8_12_22/0.16),0_44px_70px_rgb(8_12_22/0.26)]",
        className,
      )}
    >
      <SideButton className="-right-[2.5px] top-[25%] h-[11%]" />
      <SideButton className="-left-[2.5px] top-[19%] h-[7%]" />
      <SideButton className="-left-[2.5px] top-[28%] h-[7%]" />
      <div className="h-full w-full rounded-[47px] bg-[#06070a] p-[10px]">
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[38px] bg-cream">
          <StatusBar />
          {children}
          <span className="absolute left-1/2 top-[11px] size-3 -translate-x-1/2 rounded-full bg-[#0a0b0f] shadow-[inset_0_0_0_2.5px_#1d2027]" />
          <span className="absolute bottom-[7px] left-[33%] h-1 w-[34%] rounded-[2px] bg-ink/80" />
        </div>
      </div>
    </div>
  );
}

function SideButton({ className }: { className: string }) {
  return <span className={cn("absolute w-[3px] rounded-[2px] bg-[linear-gradient(#70767f,#1c1f26)]", className)} />;
}

/** Clock, signal and battery. A fixed, made-up time: this is a picture, not a live device. */
function StatusBar() {
  return (
    <div className="flex h-[34px] shrink-0 items-center justify-between bg-cream px-6 pt-[3px] text-[13px] font-semibold text-ink">
      <span>18:12</span>
      <svg viewBox="0 0 49 11" className="h-[11px] fill-ink" focusable="false">
        <rect x="0" y="7" width="3" height="4" rx="0.8" />
        <rect x="5" y="5" width="3" height="6" rx="0.8" />
        <rect x="10" y="2.5" width="3" height="8.5" rx="0.8" />
        <rect x="15" y="0" width="3" height="11" rx="0.8" />
        <rect x="25" y="0.5" width="21" height="10" rx="3" fill="none" className="stroke-ink" strokeWidth="1.2" />
        <rect x="27" y="2.5" width="14" height="6" rx="1.4" />
        <rect x="47.2" y="3.6" width="1.6" height="3.8" rx="0.8" />
      </svg>
    </div>
  );
}
