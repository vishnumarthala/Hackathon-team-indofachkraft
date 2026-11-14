import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

// Figma: Components › Alert (5:45), Info/Success/Warning/Danger.
export type AlertTone = "info" | "success" | "warning" | "danger";

const tones: Record<AlertTone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-700",
};

export function alertClasses(tone: AlertTone = "info", className?: string): string {
  return cn("rounded-lg border p-3 text-sm", tones[tone], className);
}

type AlertProps = Omit<ComponentProps<"div">, "title"> & {
  tone?: AlertTone;
  /** Optional bold first line. */
  title?: ReactNode;
  /** Render as a paragraph for one-line notices inside text flow. */
  as?: "div" | "p" | "section";
};

/**
 * Figma Alert: an inline notice. It sets no live-region role by default: pass `role="alert"` or `role="status"` where
 * the screen announced it before (keeps screen-reader behaviour unchanged).
 */
export function Alert({ tone = "info", title, as: Tag = "div", className, children, ...rest }: AlertProps) {
  return (
    <Tag className={alertClasses(tone, className)} {...rest}>
      {title ? (
        <>
          <strong className="block font-semibold">{title}</strong>{" "}
        </>
      ) : null}
      {children}
    </Tag>
  );
}
