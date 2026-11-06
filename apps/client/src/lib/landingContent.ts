/**
 * Website copy that is also used for SEO (page metadata and JSON-LD), so it lives in a plain module that both the
 * server page and the client landing component can import. Every number here is the product's real rule; if one
 * changes in apps/server/src/config/plans.ts or domain/money.ts, change it here too.
 */

export const SEO = {
  title: "Aperture: AI cold email software with warmed-up sending domains",
  description:
    "Aperture reads your website, finds your buyers, writes a personal email to each one and sends it from warmed-up domains we run. $0.04 an email. Free preview, no plan.",
  keywords: [
    "cold email software",
    "AI cold email",
    "cold email infrastructure",
    "outbound email automation",
    "warmed up email domains",
    "email deliverability",
    "B2B lead generation",
    "AI SDR",
  ],
};

export const FAQS: [string, string][] = [
  [
    "What is Aperture?",
    "Aperture is cold email software that does the whole job for you. It reads your website, finds the people most likely to buy, verifies their addresses, writes a personal four-email sequence for each one and sends it from warmed-up domains we manage. You watch the replies come in and decide what to send back.",
  ],
  [
    "Why not send cold email from my own domain?",
    "Cold email carries reputation risk. If a campaign trips a spam filter, you want that to happen on a sending domain we run, not the domain your customers, invoices and team email depend on. Your main domain never sends a cold email with Aperture.",
  ],
  [
    "How fast can I start sending?",
    "The same day. Every sending domain has already aged for 14 days and warmed for four weeks before any customer uses it, so there is no warmup wait on your side. First emails go out in each person's own working hours.",
  ],
  [
    "Where do the leads come from?",
    "From a large B2B contact database, matched to the job titles, seniority, company sizes and countries of each audience. Campaigns for local businesses can also find companies on Google Maps, and you can upload your own CSV. Every address is verified before it gets an email.",
  ],
  [
    "How do you protect deliverability?",
    "Each mailbox sends at most 30 emails a day. Emails are plain text with an unsubscribe link and no tracking pixels. Addresses that fail verification or sit on a catch-all server are never emailed, and if your bounce rate passes 4% new emails pause until your list is checked again.",
  ],
  [
    "How much does Aperture cost?",
    "$0.04 for every email: the first one, each follow-up and every reply. Finding the person, verifying the address and writing the message are included, and if we can't find an address you pay nothing. You pay from a prepaid balance, topped up from $25. There is no plan, no seat price and no setup fee.",
  ],
  [
    "Is there a free trial?",
    "Yes. The analysis of your business, your market size, sample prospects and a written sequence are free and need no card. Adding a card unlocks $10 of free credit, about 250 emails, and charges nothing. Remove the card any time.",
  ],
  [
    "Does anything send without my approval?",
    "No. Your first 20 people and their emails wait for your approval. You can review each week's new people before they are emailed, and replies we draft wait for you to press Send.",
  ],
  [
    "What happens when someone replies?",
    "Every reply is read and sorted: interested, question, later, referral, away or unsubscribe. Interested people and questions get a reply drafted for you, a later gets a follow-up date, a referral brings in the right person, and an unsubscribe goes straight to your blocklist.",
  ],
  [
    "Can I export my leads?",
    "Yes. Your leads are yours. Export every person with their full email address any time, free. Nothing is masked and there is no reveal charge.",
  ],
  [
    "Can I stop any time?",
    "Yes. There is no subscription. Pause sending whenever you like, remove your card, or close your account from the credits page. Live conversations keep working while cold email is paused: the last $2 of your balance is always kept for replies.",
  ],
];
