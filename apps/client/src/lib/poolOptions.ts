/** Markets a pool domain sends into, and the languages its sender names can be in (Admin > Domains). */

export const REGIONS = [
  ["global", "Any market"],
  ["pk", "Pakistan"],
  ["uk", "United Kingdom"],
  ["us", "United States"],
  ["eu-de", "Germany, Austria, Switzerland"],
] as const;

export const LOCALES = [
  ["en", "English"],
  ["ur", "Urdu"],
  ["ar", "Arabic"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
] as const;
