import Link from "next/link";
import { MessageCircleHeart } from "lucide-react";

/** Shared frame for sign-in, sign-up and recovery. Desktop gets a brand
 * panel that shows what the product *is* — a group conversation, with
 * each person in their own colour — instead of a generic illustration.
 * Phones get just the wordmark and the form. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <BrandPanel />
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <Link href="/login" className="mb-10 inline-flex items-center gap-2.5 lg:hidden" aria-label="Chat">
            <Wordmark />
          </Link>
          <h1 className="font-display text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-fg">{title}</h1>
          {subtitle ? <p className="mt-2 text-[15px] leading-relaxed text-muted">{subtitle}</p> : null}
          <div className="mt-8">{children}</div>
          {footer ? <div className="mt-8 text-[14.5px] text-muted">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <>
      <span className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-accent text-accent-fg">
        <MessageCircleHeart className="size-[22px]" strokeWidth={2} aria-hidden />
      </span>
      <span className="font-display text-[21px] font-bold tracking-[-0.015em] text-fg">Chat</span>
    </>
  );
}

const SAMPLE = [
  { name: "Leila", hue: 1, text: "Is everyone still up for Sunday? I'll book the table.", mine: false },
  { name: "Omid", hue: 4, text: "Wouldn't miss it. I'll bring dessert 🍰", mine: false },
  { name: "You", hue: 5, text: "Count me in, I'll be there at 1.", mine: true },
  { name: "Sara", hue: 7, text: "Save me a seat by the window ❤️", mine: false },
];

function BrandPanel() {
  return (
    <aside aria-hidden className="relative hidden w-[46%] max-w-[640px] shrink-0 flex-col justify-between overflow-hidden border-e border-line bg-panel p-12 lg:flex">
      <div className="inline-flex items-center gap-2.5">
        <Wordmark />
      </div>

      <div className="flex flex-col gap-2.5">
        {SAMPLE.map((m, i) => (
          <div key={i} className={m.mine ? "flex justify-end" : "flex items-end gap-2.5"}>
            {!m.mine ? (
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
                style={{ background: `var(--person-${m.hue}-bg)`, color: `var(--person-${m.hue}-fg)` }}
              >
                {m.name[0]}
              </span>
            ) : null}
            <div
              className={
                m.mine
                  ? "max-w-[78%] rounded-[var(--radius-bubble)] rounded-ee-[6px] bg-own px-3.5 py-2 text-[15px] leading-snug text-own-fg"
                  : "max-w-[78%] rounded-[var(--radius-bubble)] rounded-es-[6px] border border-line bg-other px-3.5 py-2 text-[15px] leading-snug text-fg"
              }
            >
              {!m.mine ? (
                <div className="text-[13px] font-bold" style={{ color: `var(--person-${m.hue}-fg)` }}>
                  {m.name}
                </div>
              ) : null}
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <p className="max-w-[420px] font-display text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-fg">
        A private place for your conversations.
      </p>
    </aside>
  );
}
