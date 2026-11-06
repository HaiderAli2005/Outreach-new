/**
 * The languages an email can be written in, with the few fixed lines we add around what the writer wrote (sign-off,
 * unsubscribe label, opt-out line), the main business language of each country, and how a website's language is
 * read from its own words. A language not listed here is never chosen for a prospect: the fixed lines would be in
 * English under an email in another language.
 */

export interface LanguageInfo {
  name: string;
  signoff: string;
  unsubscribe: string;
  optOut: string;
}

export const LANGUAGES: Record<string, LanguageInfo> = {
  en: { name: "English", signoff: "Best,", unsubscribe: "Unsubscribe", optOut: "If this isn't relevant, just say so and I won't reach out again." },
  de: { name: "German", signoff: "Viele Grüße,", unsubscribe: "Abmelden", optOut: "Falls das nicht passt, sagen Sie einfach Bescheid, dann melde ich mich nicht mehr." },
  fr: { name: "French", signoff: "Cordialement,", unsubscribe: "Se désabonner", optOut: "Si ce n'est pas pertinent, dites-le-moi simplement et je ne vous recontacterai plus." },
  es: { name: "Spanish", signoff: "Saludos,", unsubscribe: "Darse de baja", optOut: "Si no le interesa, dígamelo y no volveré a escribirle." },
  it: { name: "Italian", signoff: "Cordiali saluti,", unsubscribe: "Annulla iscrizione", optOut: "Se non è di interesse, me lo dica pure e non la ricontatterò." },
  nl: { name: "Dutch", signoff: "Met vriendelijke groet,", unsubscribe: "Uitschrijven", optOut: "Als dit niet relevant is, laat het me gerust weten, dan neem ik geen contact meer op." },
  pt: { name: "Portuguese", signoff: "Atenciosamente,", unsubscribe: "Cancelar inscrição", optOut: "Se não for relevante, é só me avisar e não entrarei mais em contato." },
  sv: { name: "Swedish", signoff: "Vänliga hälsningar,", unsubscribe: "Avregistrera", optOut: "Om det här inte är aktuellt, säg bara till så hör jag inte av mig igen." },
  da: { name: "Danish", signoff: "Venlig hilsen,", unsubscribe: "Afmeld", optOut: "Hvis det ikke er relevant, så sig det bare, så kontakter jeg dig ikke igen." },
  no: { name: "Norwegian", signoff: "Vennlig hilsen,", unsubscribe: "Meld av", optOut: "Hvis dette ikke er aktuelt, si gjerne ifra, så tar jeg ikke kontakt igjen." },
  fi: { name: "Finnish", signoff: "Ystävällisin terveisin,", unsubscribe: "Peru tilaus", optOut: "Jos tämä ei ole ajankohtaista, kerro vain, niin en ota enää yhteyttä." },
  pl: { name: "Polish", signoff: "Pozdrawiam,", unsubscribe: "Wypisz się", optOut: "Jeśli to nie jest istotne, proszę dać znać, a nie będę się więcej odzywać." },
  cs: { name: "Czech", signoff: "S pozdravem,", unsubscribe: "Odhlásit se", optOut: "Pokud to pro vás není aktuální, stačí dát vědět a už se nebudu ozývat." },
  tr: { name: "Turkish", signoff: "Saygılarımla,", unsubscribe: "Abonelikten çık", optOut: "Bu konu ilginizi çekmiyorsa söylemeniz yeterli, bir daha yazmayacağım." },
  ru: { name: "Russian", signoff: "С уважением,", unsubscribe: "Отписаться", optOut: "Если это неактуально, просто дайте знать, и я больше не буду писать." },
  ar: { name: "Arabic", signoff: "مع أطيب التحيات،", unsubscribe: "إلغاء الاشتراك", optOut: "إذا لم يكن هذا مناسباً، فقط أخبرني ولن أتواصل معك مرة أخرى." },
  he: { name: "Hebrew", signoff: "בברכה,", unsubscribe: "הסרה מרשימת התפוצה", optOut: "אם זה לא רלוונטי, פשוט תגידו ולא אפנה שוב." },
  ja: { name: "Japanese", signoff: "よろしくお願いいたします。", unsubscribe: "配信停止", optOut: "ご関心がなければ、その旨お知らせください。今後のご連絡は控えます。" },
  zh: { name: "Chinese (Simplified)", signoff: "祝好，", unsubscribe: "退订", optOut: "如果这与您无关，请告诉我，我将不再联系您。" },
  ko: { name: "Korean", signoff: "감사합니다.", unsubscribe: "수신 거부", optOut: "관련이 없으시다면 말씀해 주세요. 다시 연락드리지 않겠습니다." },
};

export const isSupported = (code: string | null | undefined): code is string => !!code && code in LANGUAGES;
export const languageInfo = (code: string | null | undefined): LanguageInfo => LANGUAGES[code ?? ""] ?? LANGUAGES.en;
export const languageName = (code: string | null | undefined): string => LANGUAGES[code ?? ""]?.name ?? code ?? "English";

/** "de-DE", "pt_BR", "nb" to the code we use, or null when we don't write in it. */
export function normalizeLanguage(tag: string | null | undefined): string | null {
  const base = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  const code = base === "nb" || base === "nn" ? "no" : base === "iw" ? "he" : base;
  return isSupported(code) ? code : null;
}

/**
 * The main business language of a country, for prospects whose website can't be read. Countries where business
 * runs in several languages (Switzerland, Belgium, Canada) are left out: there the website decides, or the
 * workspace's own language.
 */
const COUNTRY_LANGUAGE: Record<string, string> = {
  "united states": "en", "united kingdom": "en", ireland: "en", australia: "en", "new zealand": "en", "south africa": "en", india: "en",
  pakistan: "en", singapore: "en", nigeria: "en", kenya: "en", philippines: "en", "united arab emirates": "en", malaysia: "en", "hong kong": "en",
  germany: "de", austria: "de", liechtenstein: "de",
  france: "fr", monaco: "fr", luxembourg: "fr",
  spain: "es", mexico: "es", argentina: "es", colombia: "es", chile: "es", peru: "es", uruguay: "es", ecuador: "es", venezuela: "es",
  "costa rica": "es", panama: "es", guatemala: "es", "dominican republic": "es", bolivia: "es", paraguay: "es",
  italy: "it", "san marino": "it",
  netherlands: "nl",
  portugal: "pt", brazil: "pt", angola: "pt", mozambique: "pt",
  sweden: "sv", denmark: "da", norway: "no", finland: "fi",
  poland: "pl", "czech republic": "cs", czechia: "cs",
  turkey: "tr", "türkiye": "tr",
  russia: "ru", "russian federation": "ru", belarus: "ru", kazakhstan: "ru",
  "saudi arabia": "ar", egypt: "ar", jordan: "ar", morocco: "ar", kuwait: "ar", qatar: "ar", bahrain: "ar", oman: "ar", iraq: "ar", algeria: "ar", tunisia: "ar", lebanon: "ar",
  israel: "he",
  japan: "ja", china: "zh", taiwan: "zh", "south korea": "ko", korea: "ko",
};

export function countryLanguage(country: string | null | undefined): string | null {
  return COUNTRY_LANGUAGE[(country ?? "").trim().toLowerCase()] ?? null;
}

// The most common small words of each language that uses the Latin alphabet. Counting them in a page's text tells
// its language even when the page's code says "en" (a theme left on its default), which html lang alone gets wrong.
const STOPWORDS: Record<string, string[]> = {
  en: "the and to of for with you your our is are we that this on in it be from at by".split(" "),
  de: "und der die das mit für ist wir sie nicht von zu auf ein eine ihre unsere auch sich den dem".split(" "),
  fr: "et le la les des pour avec vous nous est une un du dans sur votre notre pas au aux".split(" "),
  es: "el la los las del para con que es una y en su nuestro sus por al como más".split(" "),
  it: "il di che per con è una le del della nostro sono non gli nel alla dei delle".split(" "),
  nl: "het een en van voor met is zijn wij uw onze niet ook op aan bij naar wordt".split(" "),
  pt: "os as do da para com que é uma não seu nossa em dos das no na ao mais".split(" "),
  sv: "och att det som för med är vi på av till din vår inte har kan ett våra".split(" "),
  da: "og at det som for med er vi på af til din vores ikke har kan et jeres".split(" "),
  no: "og at det som for med er vi på av til din vår ikke har kan et våre".split(" "),
  fi: "ja on että ei se ovat kanssa tai myös sekä kun meidän voit".split(" "),
  pl: "i w z na do że jest się nie dla oraz to jak przez od".split(" "),
  cs: "a v na se je že do pro s z jako jsme nebo".split(" "),
  tr: "ve bir bu için ile da de olan en çok daha gibi olarak".split(" "),
};
const STOPSETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

// The accented letters each Latin-alphabet language uses. A page full of letters its best guess never uses is in a
// language we don't write in (Hungarian's ő and ű are not Czech, Romanian's ș and ț are not Italian).
const ACCENTS: Record<string, string> = {
  en: "", de: "äöüß", fr: "àâæçéèêëîïôœùûüÿ", es: "áéíñóúü", it: "àèéìíîòóùú", nl: "áéëèíïóöúü", pt: "áâãàçéêíóôõú",
  sv: "åäöé", da: "æøåé", no: "æøåéèóô", fi: "äöåšž", pl: "ąćęłńóśźż", cs: "áčďéěíňóřšťúůýž", tr: "çğıöşüâîû",
};

/**
 * The language of a page's text, or null when it can't be told with confidence (the caller then falls back to the
 * prospect's country, then the workspace). `htmlLang` breaks close ties. Null beats a wrong guess: a Ukrainian
 * company written to in Russian, or a Pakistani one in Arabic, is worse than an email in English.
 */
export function detectLanguage(text: string, htmlLang?: string | null): string | null {
  const t = (text ?? "").slice(0, 8000);
  const count = (re: RegExp) => t.match(re)?.length ?? 0;
  const letters = count(/\p{L}/gu);
  if (letters < 40) return normalizeLanguage(htmlLang);
  const tag = normalizeLanguage(htmlLang);
  const rawTag = (htmlLang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  // The page says it is in a language we don't write in. Only a non-English guess is dropped: "uk" is a common
  // mistake for British English, and an English page is safe to answer in English.
  const foreignTag = !!rawTag && !tag;
  // Scripts other than Latin name their language at once, except where several languages share one.
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > letters * 0.05) return "ja";
  if (count(/\p{Script=Hangul}/gu) > letters * 0.3) return "ko";
  if (count(/\p{Script=Han}/gu) > letters * 0.3) return "zh";
  if (count(/\p{Script=Arabic}/gu) > letters * 0.3) {
    // Persian, Urdu, Pashto and Kurdish are written in Arabic letters plus a few of their own (پ چ ژ گ ک ی ے ٹ ڈ ڑ ں).
    return foreignTag || count(/[پچژگکیےٹڈڑںھ]/gu) > letters * 0.02 ? null : "ar";
  }
  if (count(/\p{Script=Hebrew}/gu) > letters * 0.3) return foreignTag ? null : "he";
  if (count(/\p{Script=Cyrillic}/gu) > letters * 0.3) {
    // Ukrainian has і ї є ґ; Bulgarian, Serbian and Macedonian never use Russian's ы and э.
    const russian = !foreignTag && count(/[іїєґ]/giu) <= letters * 0.005 && count(/[ыэ]/giu) > 0;
    return russian ? "ru" : null;
  }
  const words = t.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 20) return tag;
  const scores = Object.entries(STOPSETS)
    .map(([code, set]) => [code, words.filter((w) => set.has(w)).length / words.length] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  // Close neighbours (Danish, Norwegian, Swedish share most small words): the page's own tag decides between them.
  const tagScore = scores.find(([c]) => c === tag)?.[1] ?? 0;
  if (tag && tagScore > 0.05 && tagScore >= best[1] * 0.8) return tag;
  if (best[1] >= 0.06 && best[1] >= second[1] * 1.3) {
    if (foreignTag && best[0] !== "en") return null;
    const allowed = new Set(ACCENTS[best[0]] ?? "");
    const accented = [...t.toLowerCase()].filter((c) => /\p{Script=Latin}/u.test(c) && !/[a-z]/.test(c) && !allowed.has(c)).length;
    if (accented > letters * 0.01) return null;
    return best[0];
  }
  return tag;
}
