/** The persona pool: at least 8 real first names per locale (en, ur and ar first). Pure data, no imports. */
type Seed = [first: string, last: string, gender: "f" | "m"];

export const PERSONA_SEED: Record<string, { region: string; names: Seed[] }> = {
  en: {
    region: "global",
    names: [["Madison", "Reed", "f"], ["Mary", "Collins", "f"], ["Daniela", "Hart", "f"], ["Hailey", "Brooks", "f"], ["Violet", "Grant", "f"], ["Daniel", "Cole", "m"], ["Ethan", "Ward", "m"], ["Lucas", "Price", "m"], ["Grace", "Lowe", "f"], ["Noah", "Fisher", "m"]],
  },
  ur: {
    region: "pk",
    names: [["Ayesha", "Khan", "f"], ["Hamza", "Malik", "m"], ["Sana", "Qureshi", "f"], ["Bilal", "Ahmed", "m"], ["Hira", "Siddiqui", "f"], ["Usman", "Raza", "m"], ["Mahnoor", "Iqbal", "f"], ["Fahad", "Butt", "m"]],
  },
  ar: {
    region: "ae",
    names: [["Layla", "Haddad", "f"], ["Omar", "Nasser", "m"], ["Noor", "Saleh", "f"], ["Yousef", "Karim", "m"], ["Mariam", "Aziz", "f"], ["Khalid", "Mansour", "m"], ["Huda", "Farouk", "f"], ["Tariq", "Hamdan", "m"]],
  },
  de: {
    region: "eu-de",
    names: [["Lena", "Becker", "f"], ["Jonas", "Weber", "m"], ["Hannah", "Schulz", "f"], ["Lukas", "Hoffmann", "m"], ["Lea", "Wagner", "f"], ["Felix", "Koch", "m"], ["Mia", "Richter", "f"], ["Paul", "Klein", "m"]],
  },
  fr: {
    region: "eu-fr",
    names: [["Camille", "Martin", "f"], ["Louis", "Bernard", "m"], ["Chloé", "Dubois", "f"], ["Hugo", "Moreau", "m"], ["Léa", "Laurent", "f"], ["Lucas", "Girard", "m"], ["Manon", "Roux", "f"], ["Jules", "Fontaine", "m"]],
  },
  es: {
    region: "eu-es",
    names: [["Lucía", "García", "f"], ["Pablo", "Martínez", "m"], ["Sofía", "López", "f"], ["Javier", "Sánchez", "m"], ["Elena", "Romero", "f"], ["Diego", "Torres", "m"], ["Carmen", "Ruiz", "f"], ["Álvaro", "Navarro", "m"]],
  },
};

