/**
 * ============================================================================
 * lib/places.ts — BUILT-IN CITIES AND COUNTRIES FOR LOCATION SEARCH
 * ============================================================================
 *
 * The Recon page's location box asks app/api/geocode for matches. That route
 * uses Open-Meteo's free geocoder (any town worldwide), and falls back to this
 * list when the geocoder can't be reached. This list is also what answers a
 * bare country name ("Australia"): a country is placed at its biggest
 * internet hub, which is what matters for latency, not its geographic centre.
 *
 * Coordinates are approximate (±0.1°); latency estimates don't need more.
 * ============================================================================
 */

export interface Place {
  name: string;          // 'Melbourne' or 'Australia'
  country: string;       // 'Australia'
  countryCode: string;   // 'AU'
  admin?: string;        // state / province, when known
  lat: number;
  lng: number;
  kind: 'city' | 'country';
}

// [country, code, hub city, lat, lng]
const COUNTRIES: Array<[string, string, string, number, number]> = [
  ['Argentina', 'AR', 'Buenos Aires', -34.6, -58.38], ['Australia', 'AU', 'Sydney', -33.87, 151.21],
  ['Austria', 'AT', 'Vienna', 48.21, 16.37], ['Bangladesh', 'BD', 'Dhaka', 23.81, 90.41],
  ['Belgium', 'BE', 'Brussels', 50.85, 4.35], ['Brazil', 'BR', 'São Paulo', -23.55, -46.63],
  ['Bulgaria', 'BG', 'Sofia', 42.7, 23.32], ['Cambodia', 'KH', 'Phnom Penh', 11.56, 104.92],
  ['Canada', 'CA', 'Toronto', 43.65, -79.38], ['Chile', 'CL', 'Santiago', -33.45, -70.67],
  ['China', 'CN', 'Shanghai', 31.23, 121.47], ['Colombia', 'CO', 'Bogotá', 4.71, -74.07],
  ['Croatia', 'HR', 'Zagreb', 45.81, 15.98], ['Czechia', 'CZ', 'Prague', 50.08, 14.44],
  ['Denmark', 'DK', 'Copenhagen', 55.68, 12.57], ['Egypt', 'EG', 'Cairo', 30.04, 31.24],
  ['Estonia', 'EE', 'Tallinn', 59.44, 24.75], ['Finland', 'FI', 'Helsinki', 60.17, 24.94],
  ['France', 'FR', 'Paris', 48.86, 2.35], ['Germany', 'DE', 'Frankfurt', 50.11, 8.68],
  ['Greece', 'GR', 'Athens', 37.98, 23.73], ['Hong Kong', 'HK', 'Hong Kong', 22.32, 114.17],
  ['Hungary', 'HU', 'Budapest', 47.5, 19.04], ['Iceland', 'IS', 'Reykjavík', 64.15, -21.94],
  ['India', 'IN', 'Mumbai', 19.08, 72.88], ['Indonesia', 'ID', 'Jakarta', -6.21, 106.85],
  ['Ireland', 'IE', 'Dublin', 53.35, -6.26], ['Israel', 'IL', 'Tel Aviv', 32.09, 34.78],
  ['Italy', 'IT', 'Milan', 45.46, 9.19], ['Japan', 'JP', 'Tokyo', 35.68, 139.69],
  ['Kenya', 'KE', 'Nairobi', -1.29, 36.82], ['Latvia', 'LV', 'Riga', 56.95, 24.11],
  ['Lithuania', 'LT', 'Vilnius', 54.69, 25.28], ['Luxembourg', 'LU', 'Luxembourg', 49.61, 6.13],
  ['Malaysia', 'MY', 'Kuala Lumpur', 3.14, 101.69], ['Mexico', 'MX', 'Mexico City', 19.43, -99.13],
  ['Morocco', 'MA', 'Casablanca', 33.57, -7.59], ['Netherlands', 'NL', 'Amsterdam', 52.37, 4.9],
  ['New Zealand', 'NZ', 'Auckland', -36.85, 174.76], ['Nigeria', 'NG', 'Lagos', 6.52, 3.38],
  ['Norway', 'NO', 'Oslo', 59.91, 10.75], ['Pakistan', 'PK', 'Karachi', 24.86, 67.01],
  ['Peru', 'PE', 'Lima', -12.05, -77.04], ['Philippines', 'PH', 'Manila', 14.6, 120.98],
  ['Poland', 'PL', 'Warsaw', 52.23, 21.01], ['Portugal', 'PT', 'Lisbon', 38.72, -9.14],
  ['Qatar', 'QA', 'Doha', 25.29, 51.53], ['Romania', 'RO', 'Bucharest', 44.43, 26.1],
  ['Saudi Arabia', 'SA', 'Riyadh', 24.71, 46.68], ['Serbia', 'RS', 'Belgrade', 44.79, 20.45],
  ['Singapore', 'SG', 'Singapore', 1.35, 103.82], ['Slovakia', 'SK', 'Bratislava', 48.15, 17.11],
  ['Slovenia', 'SI', 'Ljubljana', 46.06, 14.51], ['South Africa', 'ZA', 'Johannesburg', -26.2, 28.05],
  ['South Korea', 'KR', 'Seoul', 37.57, 126.98], ['Spain', 'ES', 'Madrid', 40.42, -3.7],
  ['Sri Lanka', 'LK', 'Colombo', 6.93, 79.86], ['Sweden', 'SE', 'Stockholm', 59.33, 18.07],
  ['Switzerland', 'CH', 'Zurich', 47.38, 8.54], ['Taiwan', 'TW', 'Taipei', 25.03, 121.57],
  ['Thailand', 'TH', 'Bangkok', 13.76, 100.5], ['Turkey', 'TR', 'Istanbul', 41.01, 28.98],
  ['Ukraine', 'UA', 'Kyiv', 50.45, 30.52], ['United Arab Emirates', 'AE', 'Dubai', 25.2, 55.27],
  ['United Kingdom', 'GB', 'London', 51.51, -0.13], ['United States', 'US', 'Chicago', 41.88, -87.63],
  ['Uruguay', 'UY', 'Montevideo', -34.9, -56.16], ['Vietnam', 'VN', 'Ho Chi Minh City', 10.82, 106.63],
];

// Aliases people type for countries.
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States', us: 'United States', america: 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', britain: 'United Kingdom', 'great britain': 'United Kingdom', england: 'United Kingdom',
  scotland: 'United Kingdom', wales: 'United Kingdom', uae: 'United Arab Emirates', korea: 'South Korea',
  holland: 'Netherlands', 'czech republic': 'Czechia', nz: 'New Zealand', oz: 'Australia',
};

// Other names people type for cities.
const CITY_ALIASES: Record<string, string> = {
  bangalore: 'Bengaluru', bombay: 'Mumbai', madras: 'Chennai', calcutta: 'Kolkata', saigon: 'Ho Chi Minh City',
  nyc: 'New York', hawaii: 'Honolulu', oahu: 'Honolulu',
};

// [city, admin/state, country code, lat, lng]
const CITIES: Array<[string, string, string, number, number]> = [
  // Oceania
  ['Sydney', 'New South Wales', 'AU', -33.87, 151.21], ['Melbourne', 'Victoria', 'AU', -37.81, 144.96],
  ['Brisbane', 'Queensland', 'AU', -27.47, 153.03], ['Perth', 'Western Australia', 'AU', -31.95, 115.86],
  ['Adelaide', 'South Australia', 'AU', -34.93, 138.6], ['Canberra', 'ACT', 'AU', -35.28, 149.13],
  ['Hobart', 'Tasmania', 'AU', -42.88, 147.33], ['Darwin', 'Northern Territory', 'AU', -12.46, 130.84],
  ['Gold Coast', 'Queensland', 'AU', -28.02, 153.4], ['Newcastle', 'New South Wales', 'AU', -32.93, 151.78],
  ['Auckland', '', 'NZ', -36.85, 174.76], ['Wellington', '', 'NZ', -41.29, 174.78], ['Christchurch', '', 'NZ', -43.53, 172.64],
  // Asia
  ['Singapore', '', 'SG', 1.35, 103.82], ['Kuala Lumpur', '', 'MY', 3.14, 101.69], ['Jakarta', '', 'ID', -6.21, 106.85],
  ['Bangkok', '', 'TH', 13.76, 100.5], ['Manila', '', 'PH', 14.6, 120.98], ['Ho Chi Minh City', '', 'VN', 10.82, 106.63],
  ['Hanoi', '', 'VN', 21.03, 105.85], ['Hong Kong', '', 'HK', 22.32, 114.17], ['Taipei', '', 'TW', 25.03, 121.57],
  ['Tokyo', '', 'JP', 35.68, 139.69], ['Osaka', '', 'JP', 34.69, 135.5], ['Seoul', '', 'KR', 37.57, 126.98],
  ['Busan', '', 'KR', 35.18, 129.08], ['Shanghai', '', 'CN', 31.23, 121.47], ['Beijing', '', 'CN', 39.9, 116.4],
  ['Shenzhen', '', 'CN', 22.54, 114.06], ['Mumbai', 'Maharashtra', 'IN', 19.08, 72.88], ['Delhi', '', 'IN', 28.61, 77.21],
  ['Bengaluru', 'Karnataka', 'IN', 12.97, 77.59], ['Chennai', 'Tamil Nadu', 'IN', 13.08, 80.27],
  ['Hyderabad', 'Telangana', 'IN', 17.39, 78.49], ['Pune', 'Maharashtra', 'IN', 18.52, 73.86],
  ['Kolkata', 'West Bengal', 'IN', 22.57, 88.36], ['Karachi', '', 'PK', 24.86, 67.01], ['Dhaka', '', 'BD', 23.81, 90.41],
  ['Colombo', '', 'LK', 6.93, 79.86], ['Dubai', '', 'AE', 25.2, 55.27], ['Abu Dhabi', '', 'AE', 24.45, 54.38],
  ['Doha', '', 'QA', 25.29, 51.53], ['Riyadh', '', 'SA', 24.71, 46.68], ['Tel Aviv', '', 'IL', 32.09, 34.78],
  ['Istanbul', '', 'TR', 41.01, 28.98],
  // Europe
  ['London', 'England', 'GB', 51.51, -0.13], ['Manchester', 'England', 'GB', 53.48, -2.24],
  ['Birmingham', 'England', 'GB', 52.49, -1.89], ['Edinburgh', 'Scotland', 'GB', 55.95, -3.19],
  ['Glasgow', 'Scotland', 'GB', 55.86, -4.25], ['Dublin', '', 'IE', 53.35, -6.26], ['Paris', '', 'FR', 48.86, 2.35],
  ['Marseille', '', 'FR', 43.3, 5.37], ['Lyon', '', 'FR', 45.76, 4.84], ['Amsterdam', '', 'NL', 52.37, 4.9],
  ['Brussels', '', 'BE', 50.85, 4.35], ['Frankfurt', 'Hesse', 'DE', 50.11, 8.68], ['Berlin', '', 'DE', 52.52, 13.4],
  ['Munich', 'Bavaria', 'DE', 48.14, 11.58], ['Hamburg', '', 'DE', 53.55, 9.99], ['Zurich', '', 'CH', 47.38, 8.54],
  ['Vienna', '', 'AT', 48.21, 16.37], ['Milan', '', 'IT', 45.46, 9.19], ['Rome', '', 'IT', 41.9, 12.5],
  ['Madrid', '', 'ES', 40.42, -3.7], ['Barcelona', '', 'ES', 41.39, 2.17], ['Lisbon', '', 'PT', 38.72, -9.14],
  ['Stockholm', '', 'SE', 59.33, 18.07], ['Oslo', '', 'NO', 59.91, 10.75], ['Copenhagen', '', 'DK', 55.68, 12.57],
  ['Helsinki', '', 'FI', 60.17, 24.94], ['Warsaw', '', 'PL', 52.23, 21.01], ['Prague', '', 'CZ', 50.08, 14.44],
  ['Budapest', '', 'HU', 47.5, 19.04], ['Bucharest', '', 'RO', 44.43, 26.1], ['Athens', '', 'GR', 37.98, 23.73],
  ['Kyiv', '', 'UA', 50.45, 30.52],
  // Americas
  ['New York', 'New York', 'US', 40.71, -74.01], ['Los Angeles', 'California', 'US', 34.05, -118.24],
  ['San Francisco', 'California', 'US', 37.77, -122.42], ['San Jose', 'California', 'US', 37.34, -121.89],
  ['Seattle', 'Washington', 'US', 47.61, -122.33], ['Portland', 'Oregon', 'US', 45.52, -122.68],
  ['Chicago', 'Illinois', 'US', 41.88, -87.63], ['Dallas', 'Texas', 'US', 32.78, -96.8],
  ['Houston', 'Texas', 'US', 29.76, -95.37], ['Austin', 'Texas', 'US', 30.27, -97.74],
  ['Denver', 'Colorado', 'US', 39.74, -104.99], ['Phoenix', 'Arizona', 'US', 33.45, -112.07],
  ['Las Vegas', 'Nevada', 'US', 36.17, -115.14], ['Atlanta', 'Georgia', 'US', 33.75, -84.39],
  ['Miami', 'Florida', 'US', 25.76, -80.19], ['Washington', 'D.C.', 'US', 38.91, -77.04],
  ['Boston', 'Massachusetts', 'US', 42.36, -71.06], ['Philadelphia', 'Pennsylvania', 'US', 39.95, -75.17],
  ['Minneapolis', 'Minnesota', 'US', 44.98, -93.27], ['Salt Lake City', 'Utah', 'US', 40.76, -111.89],
  ['Honolulu', 'Hawaii', 'US', 21.31, -157.86], ['Anchorage', 'Alaska', 'US', 61.22, -149.9],
  ['Toronto', 'Ontario', 'CA', 43.65, -79.38], ['Montreal', 'Quebec', 'CA', 45.5, -73.57],
  ['Vancouver', 'British Columbia', 'CA', 49.28, -123.12], ['Calgary', 'Alberta', 'CA', 51.05, -114.07],
  ['Mexico City', '', 'MX', 19.43, -99.13], ['São Paulo', '', 'BR', -23.55, -46.63], ['Rio de Janeiro', '', 'BR', -22.91, -43.17],
  ['Buenos Aires', '', 'AR', -34.6, -58.38], ['Santiago', '', 'CL', -33.45, -70.67], ['Bogotá', '', 'CO', 4.71, -74.07],
  ['Lima', '', 'PE', -12.05, -77.04],
  // Africa
  ['Johannesburg', 'Gauteng', 'ZA', -26.2, 28.05], ['Cape Town', 'Western Cape', 'ZA', -33.92, 18.42],
  ['Lagos', '', 'NG', 6.52, 3.38], ['Nairobi', '', 'KE', -1.29, 36.82], ['Cairo', '', 'EG', 30.04, 31.24],
  ['Casablanca', '', 'MA', 33.57, -7.59],
];

const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map(([name, code]) => [code, name]));

export const PLACES: Place[] = [
  ...COUNTRIES.map(([country, code, , lat, lng]): Place => ({ name: country, country, countryCode: code, lat, lng, kind: 'country' })),
  ...CITIES.map(([name, admin, code, lat, lng]): Place => ({
    name, admin: admin || undefined, country: COUNTRY_BY_CODE[code] || code, countryCode: code, lat, lng, kind: 'city',
  })),
];

/** Hub city a country is represented by, e.g. 'Sydney' for Australia. */
export function countryHub(code: string): string | undefined {
  return COUNTRIES.find((c) => c[1] === code)?.[2];
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Search the built-in list. Accepts "Melbourne", "melb", "Australia",
 * "uk", or "Melbourne, Australia" / "Portland, Oregon" (the part after the
 * comma narrows by state or country).
 */
export function searchPlaces(q: string, limit = 8): Place[] {
  const [rawName, rawFilter] = q.split(',').map((p) => norm(p || ''));
  if (!rawName) return [];
  const alias = COUNTRY_ALIASES[rawName] || CITY_ALIASES[rawName];
  const name = alias ? norm(alias) : rawName;
  const filterAlias = rawFilter && COUNTRY_ALIASES[rawFilter] ? norm(COUNTRY_ALIASES[rawFilter]) : null;
  const matchesFilter = (p: Place) =>
    !rawFilter || [p.country, p.countryCode, p.admin || ''].some((f) => f && (norm(f).startsWith(rawFilter) || norm(f) === filterAlias));
  const score = (p: Place) => {
    const n = norm(p.name);
    if (n === name) return 0;
    if (n.startsWith(name)) return 1;
    if (n.split(/\s+/).some((w) => w.startsWith(name))) return 2;
    return -1;
  };
  return PLACES
    .map((p) => ({ p, s: score(p) }))
    .filter(({ p, s }) => s >= 0 && matchesFilter(p))
    .sort((a, b) => a.s - b.s || (a.p.kind === 'country' ? -1 : 1) - (b.p.kind === 'country' ? -1 : 1) || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map(({ p }) => p);
}

/** 'Melbourne, Victoria, Australia' / 'Australia'. */
export function placeLabel(p: Place): string {
  return p.kind === 'country' ? p.country : [p.name, p.admin, p.country].filter(Boolean).join(', ');
}
