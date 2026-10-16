/** Languages written right to left. The analysis stores a language code; anything else is decided by the text itself. */
const RTL_LANGS = new Set(["ar", "ur", "fa", "he", "ps", "sd", "ug", "yi", "ckb", "dv"]);

export function isRtlLang(lang?: string | null): boolean {
  return !!lang && RTL_LANGS.has(lang.toLowerCase().split(/[-_]/)[0]);
}

/**
 * Text direction for a block. A known right-to-left language is forced to rtl (an email that starts with a
 * Latin name like "Usman" would otherwise be read as left to right); everything else lets the browser decide.
 */
export function dirFor(lang?: string | null): "rtl" | "auto" {
  return isRtlLang(lang) ? "rtl" : "auto";
}
