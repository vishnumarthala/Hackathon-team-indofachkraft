// Message key types derived from messages/en.json (the source of truth). Type-only: nothing is bundled.
import type en from "@/messages/en.json";

export type Catalogue = typeof en;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

type Branches<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? never : `${P}${K}` | Branches<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every leaf key in dot notation, e.g. `login.title` or `landing.features.fromConfirmed_one`. */
export type MessageKey = Leaves<Catalogue>;

/** Base keys of plural pairs: `foo` when `foo_one` / `foo_other` exist. Call `t("foo", { count })`. */
export type PluralKey = MessageKey extends infer K ? (K extends `${infer Base}_other` ? Base : never) : never;

/** Anything `t()` accepts without a namespace. `t("unknown.key")` is a type error. */
export type TranslationKey = MessageKey | PluralKey;

/** Object paths usable as a `getT(namespace)` / `useT(namespace)` prefix, e.g. `login` or `landing.hero`. */
export type Namespace = Branches<Catalogue>;

/** Keys relative to a namespace: `KeyIn<"login">` includes `"title"`. */
export type KeyIn<N extends Namespace | undefined> = N extends string
  ? TranslationKey extends infer K
    ? K extends `${N}.${infer Rest}`
      ? Rest
      : never
    : never
  : TranslationKey;

export type TranslationValues = Record<string, string | number>;

export type TFunction<N extends Namespace | undefined = undefined> = (key: KeyIn<N>, values?: TranslationValues) => string;
