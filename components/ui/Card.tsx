import type { HTMLAttributes } from "react";
import { cn } from "./cn";

// Surface used by Figma's card components (Stat card 9:305, Appointment card 9:344, Goal card 9:332):
// bg/canvas, border/default, radius/lg, space/4.
export const cardClasses = "rounded-lg border border-slate-200 bg-white p-4";

type CardProps = HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article" | "li" };

export function Card({ as: Tag = "div", className, ...rest }: CardProps) {
  return <Tag className={cn(cardClasses, className)} {...rest} />;
}
