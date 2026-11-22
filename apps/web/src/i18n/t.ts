/** Interpolation and Polish plurals for catalogue strings from `./pl.ts`. */

export type Params = Record<string, string | number>;

/** Replaces `{name}` placeholders; unknown placeholders stay visible so a missing parameter is noticed. */
export function t(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export interface PluralForms {
  one: string;
  few: string;
  many: string;
}

const pluralRules = new Intl.PluralRules('pl-PL');

/** Polish plural: 1 adres, 2–4 adresy, 5+ adresów (22 adresy, 12 adresów). `{count}` is filled in. */
export function plural(count: number, forms: PluralForms, params: Params = {}): string {
  const category = pluralRules.select(count);
  const template = category === 'one' ? forms.one : category === 'few' ? forms.few : forms.many;
  return t(template, { ...params, count });
}

/** Catalogue lookup for engine keys (feature, gate, reason code…): unknown keys come back as `null`. */
export function lookup(map: Readonly<Record<string, string>>, key: string | undefined): string | null {
  if (key === undefined) return null;
  return Object.hasOwn(map, key) ? (map[key] ?? null) : null;
}
