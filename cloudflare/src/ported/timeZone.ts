// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
/**
 * Browsers report time zones by ICU's ids, and ICU still uses a few old names
 * ("Asia/Calcutta", "Europe/Kiev") that tzdata keeps only as backward links.
 * PostgreSQL resolves AT TIME ZONE against its own tzdata, and builds that
 * leave the backward links out (Debian moved them to tzdata-legacy; the
 * official postgres:18 image) reject those names — so every analytics query
 * failed for a visitor in India. Zones are mapped to the current IANA name
 * before they reach SQL.
 */

/** ICU's legacy ids that differ from the current IANA name. */
const IANA_NAME: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** The current IANA name of a zone the runtime knows, else UTC. Safe to hand to PostgreSQL. */
export function resolveTimeZone(value: string | null | undefined): string {
  if (!value) return "UTC";
  let zone: string;
  try {
    zone = new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
  return IANA_NAME[zone] ?? zone;
}
