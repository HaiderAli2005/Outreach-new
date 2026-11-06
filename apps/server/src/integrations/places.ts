import { fetchJson } from "./http.js";
import { getCredential } from "./credentials.js";

/**
 * Google Maps as a lead source, through the Places API (New) Text Search. It returns businesses, not people: name,
 * address, website and category. One request is one billed call, so callers cap how many they make.
 *
 * Maps Platform terms: the place id may be kept; other place content may only be cached for a limited time, so
 * MapsPlace clears name and address after 30 days. Never scrape google.com/maps instead of using this API.
 */

export interface Place {
  id: string;
  name: string | null;
  address: string | null;
  website: string | null;
  city: string | null;
  types: string[];
}

export interface PlacesApi {
  searchText(query: string, opts?: { regionCode?: string | null; pageToken?: string | null }): Promise<{ places: Place[]; next: string | null }>;
}

const FIELDS = ["places.id", "places.displayName", "places.formattedAddress", "places.websiteUri", "places.types", "places.addressComponents", "nextPageToken"].join(",");

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  types?: string[];
  addressComponents?: { longText?: string; types?: string[] }[];
}

export function placeOf(p: RawPlace): Place | null {
  if (!p.id) return null;
  const part = (t: string) => p.addressComponents?.find((c) => c.types?.includes(t))?.longText ?? null;
  return {
    id: p.id,
    name: p.displayName?.text ?? null,
    address: p.formattedAddress ?? null,
    website: p.websiteUri ?? null,
    city: part("locality") ?? part("administrative_area_level_2") ?? part("administrative_area_level_1"),
    types: p.types ?? [],
  };
}

export class PlacesClient implements PlacesApi {
  constructor(private readonly key: string) {}
  async searchText(query: string, opts: { regionCode?: string | null; pageToken?: string | null } = {}) {
    const data = await fetchJson<{ places?: RawPlace[]; nextPageToken?: string }>("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "X-Goog-Api-Key": this.key, "X-Goog-FieldMask": FIELDS },
      body: { textQuery: query, pageSize: 20, languageCode: "en", ...(opts.regionCode ? { regionCode: opts.regionCode } : {}), ...(opts.pageToken ? { pageToken: opts.pageToken } : {}) },
    });
    return { places: (data.places ?? []).map(placeOf).filter((p): p is Place => !!p), next: data.nextPageToken ?? null };
  }
}

type Factory = (orgId: string) => Promise<PlacesApi | null>;
const defaultFactory: Factory = async (orgId) => {
  const key = await getCredential(orgId, "GOOGLE_PLACES");
  return key ? new PlacesClient(key) : null;
};
let factory: Factory = defaultFactory;

export function placesFor(orgId: string): Promise<PlacesApi | null> {
  return factory(orgId);
}

export function setPlacesFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}
