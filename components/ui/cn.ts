/** Joins class names, skipping falsy values. No conflict resolution: pick a variant/size instead of overriding. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
