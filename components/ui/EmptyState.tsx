import type { ReactNode } from "react";
import { cn } from "./cn";

// Composed from tokens (bg/subtle, border/strong dashed, text/secondary); the Figma screens draw it inline.
type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Usually a `<Button>`. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cn("rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center", className)}>
      {icon ? (
        <div aria-hidden="true" className="mb-2 flex justify-center text-slate-500">
          {icon}
        </div>
      ) : null}
      <p className="font-medium text-slate-900">{title}</p>
      {description ? <p className="mt-1 text-sm text-slate-700">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
