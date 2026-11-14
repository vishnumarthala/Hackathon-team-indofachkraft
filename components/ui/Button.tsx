import Link from "next/link";
import { Children, cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./variants";

export { buttonClasses, focusRing, type ButtonSize, type ButtonVariant } from "./variants";

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (decorative; hidden from assistive tech). */
  icon?: ReactNode;
  /** Shows a spinner, sets aria-busy and blocks interaction. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

type AsButton = CommonProps & Omit<ComponentProps<"button">, keyof CommonProps> & { href?: undefined; asChild?: false };
type AsLink = CommonProps &
  Omit<ComponentProps<typeof Link>, keyof CommonProps | "href"> & { href: ComponentProps<typeof Link>["href"]; disabled?: boolean; asChild?: false };
type AsChild = CommonProps & { asChild: true; href?: undefined; disabled?: boolean };

export type ButtonProps = AsButton | AsLink | AsChild;

function Spinner() {
  return <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />;
}

function Content({ icon, loading, children }: { icon?: ReactNode; loading?: boolean; children?: ReactNode }) {
  return (
    <>
      {loading ? <Spinner /> : icon ? <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span> : null}
      {children}
    </>
  );
}

/**
 * Figma Button. Renders a `<button>` (default `type="button"`), a Next.js `<Link>` when `href` is given, or merges its
 * classes onto a single child element with `asChild` (e.g. `<label>` for file inputs, `<a download>`).
 */
export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", icon, loading = false, className, children } = props;
  const classes = buttonClasses({ variant, size, className });
  const state = {
    ...(loading ? { "aria-busy": true as const } : {}),
    ...(loading || props.disabled ? { "aria-disabled": true as const } : {}),
  };

  if (props.asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) return null;
    const el = child as ReactElement<{ className?: string; children?: ReactNode }>;
    return cloneElement(el, { className: cn(classes, el.props.className), ...state }, <Content icon={icon} loading={loading}>{el.props.children}</Content>);
  }

  if (props.href !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { variant: _v, size: _s, icon: _i, loading: _l, className: _c, children: _ch, disabled, href, ...rest } = props as AsLink;
    if (disabled || loading) {
      // A disabled link has no href, so it is not focusable or followable; it stays an <a> for layout.
      return (
        <a role="link" className={classes} {...state}>
          <Content icon={icon} loading={loading}>{children}</Content>
        </a>
      );
    }
    return (
      <Link href={href} className={classes} {...rest}>
        <Content icon={icon}>{children}</Content>
      </Link>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { variant: _v, size: _s, icon: _i, loading: _l, className: _c, children: _ch, asChild: _a, type = "button", disabled, ...rest } = props as AsButton;
  return (
    <button type={type} disabled={disabled || loading} className={classes} {...rest} {...state}>
      <Content icon={icon} loading={loading}>{children}</Content>
    </button>
  );
}
