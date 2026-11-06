import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setSiteLanguageReader } from "../src/integrations/site.js";
import { languageFor } from "../src/domain/prospectLanguage.js";
import { detectLanguage, normalizeLanguage } from "../src/domain/languages.js";
import { checkFirstTouch, checkSubject, unsupportedClaims, wordCount } from "../src/domain/emailRules.js";
import { composeBody } from "../src/domain/sending/message.js";
import { optOutLine } from "../src/domain/sequence.js";

/** Each prospect is written to in their own website's main language, else their country's, else the workspace's. */

const GERMAN =
  "Wir sind ein Familienunternehmen aus München und entwickeln seit über zwanzig Jahren Software für den Mittelstand. Unsere Kunden schätzen die persönliche Betreuung und die schnelle Umsetzung. Mit unserem Team von Experten begleiten wir Sie von der ersten Idee bis zum fertigen Produkt und darüber hinaus.";
const ENGLISH =
  "We are a family business from Manchester and have built software for small companies for over twenty years. Our customers value the personal service and fast delivery. With our team of experts we take you from the first idea to the finished product and beyond.";

describe("the language of a website", () => {
  it("reads the page's own words, even when its code says English (a theme left on its default)", () => {
    expect(detectLanguage(GERMAN, "en")).toBe("de");
    expect(detectLanguage(ENGLISH, "en-US")).toBe("en");
    expect(detectLanguage("株式会社サンプルは、東京を拠点に中小企業向けのソフトウェアを開発しています。お客様一人ひとりに寄り添ったサービスを提供します。", null)).toBe("ja");
    expect(detectLanguage("شركتنا تقدم حلول برمجية للشركات الصغيرة والمتوسطة في المملكة العربية السعودية منذ أكثر من عشرين عاماً", null)).toBe("ar");
  });

  it("never guesses a neighbouring language for one it can't write in", () => {
    // Cyrillic is not always Russian, Arabic letters are not always Arabic, and Hungarian is not Czech.
    const ukrainian = "Ми українська компанія, яка розробляє програмне забезпечення для малого та середнього бізнесу. Наші клієнти цінують якість, швидкість і чесність. Зв'яжіться з нами, щоб дізнатися більше.";
    const bulgarian = "Ние сме българска компания, която разработва софтуер за малкия и средния бизнес. Нашите клиенти ценят качеството, бързината и честността. Свържете се с нас, за да научите повече.";
    const urdu = "ہم ایک پاکستانی کمپنی ہیں جو چھوٹے اور درمیانے کاروبار کے لیے سافٹ ویئر تیار کرتی ہے۔ ہمارے گاہک معیار، رفتار اور ایمانداری کو اہمیت دیتے ہیں۔";
    const hungarian = "Magyar vállalat vagyunk, amely szoftvert fejleszt kis- és középvállalkozások számára. Ügyfeleink értékelik a minőséget, a gyorsaságot és az őszinteséget. Lépjen kapcsolatba velünk, hogy többet megtudjon szolgáltatásainkról és árainkról.";
    for (const text of [ukrainian, bulgarian, urdu, hungarian]) {
      expect(detectLanguage(text, null)).toBeNull();
    }
    expect(detectLanguage(ukrainian, "uk")).toBeNull();
    expect(detectLanguage("Мы российская компания, которая разрабатывает программное обеспечение для малого и среднего бизнеса. Наши клиенты ценят качество, скорость и честность. Свяжитесь с нами.", null)).toBe("ru");
    // lang="uk" is a common slip for British English: an English page stays English.
    expect(detectLanguage(ENGLISH, "uk")).toBe("en");
  });

  it("falls back to the page's tag when there are too few words, and knows only languages it can write in", () => {
    expect(detectLanguage("Willkommen", "de-DE")).toBe("de");
    expect(normalizeLanguage("nb-NO")).toBe("no");
    expect(normalizeLanguage("hu")).toBeNull();
  });
});

describe("a prospect's language", () => {
  beforeEach(resetDb);

  it("is their website's language, worked out once per company and kept", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    let reads = 0;
    setSiteLanguageReader(async () => {
      reads++;
      return { lang: "en", text: GERMAN };
    });
    const a = await makeContact(t.orgId, { campaignId: campaign.id, companyDomain: "muster.de", country: "United Kingdom" });
    const b = await makeContact(t.orgId, { campaignId: campaign.id, companyDomain: "muster.de", email: "b@muster.de", emailNormalized: "b@muster.de" });
    expect(await languageFor(a, "en")).toBe("de");
    expect(await languageFor(b, "en")).toBe("de");
    expect(reads).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: b.id } })).language).toBe("de");
  });

  it("is their country's language when the website can't be read, else the workspace's", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const fr = await makeContact(t.orgId, { campaignId: campaign.id, companyDomain: "exemple.fr", country: "France" });
    expect(await languageFor(fr, "en")).toBe("fr");
    const ch = await makeContact(t.orgId, { campaignId: campaign.id, companyDomain: "beispiel.ch", country: "Switzerland", email: "x@beispiel.ch", emailNormalized: "x@beispiel.ch" });
    expect(await languageFor(ch, "en")).toBe("en");
  });
});

describe("the rules in other languages", () => {
  it("counts Chinese and Japanese words without spaces, and accepts their question mark", () => {
    expect(wordCount("我们为中小企业提供软件")).toBeGreaterThan(3);
    const ja = `${"弊社は中小企業向けのソフトウェアを開発しております。".repeat(9)}\n\n来週、十五分ほどお時間をいただけますでしょうか？`;
    expect(checkFirstTouch(ja, "ja")).toBeNull();
  });

  it("does not take German nouns for unsupported names, but still checks numbers", () => {
    const text = "Ihre Kunden schätzen schnelle Lieferung und gute Beratung. Wir helfen Unternehmen wie Ihrem.";
    expect(unsupportedClaims(text, { prospect: "", customer: "" }, "de")).toEqual([]);
    expect(unsupportedClaims("Wir sparen 40% Zeit.", { prospect: "", customer: "" }, "de")).toEqual(["40%"]);
  });

  it("checks subjects in scripts with and without capitals", () => {
    expect(checkSubject("Lieferketten im Mittelstand")).toBeNull();
    expect(checkSubject("中小企業の業務効率化")).toBeNull();
    expect(checkSubject("lieferketten im mittelstand")).toBe("is not in sentence case");
  });
});

describe("the lines we add", () => {
  it("signs off, unsubscribes and opts out in the email's language", () => {
    const body = composeBody({ text: "Hallo Anna,\n\nText.", senderFirstName: "Madison", footer: optOutLine({ optOutLine: null, language: "en" }, "de"), unsubscribeUrl: "https://x.example/u/1", language: "de" });
    expect(body).toContain("Viele Grüße,\nMadison");
    expect(body).toContain("Abmelden: https://x.example/u/1");
    expect(body).toContain("Falls das nicht passt");
  });

  it("uses the customer's own opt-out line only for emails in their language", () => {
    const s = { optOutLine: "Not for you? Tell me and I'll stop.", language: "en" };
    expect(optOutLine(s, "en")).toBe("Not for you? Tell me and I'll stop.");
    expect(optOutLine(s, "fr")).toMatch(/^Si ce n'est pas pertinent/);
  });
});
