import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import type { Env, Row } from "../types";
import { pref, ensure } from "./shared";
export async function normalizePhone(env: Env, org: string, value: unknown) {
  const general = await pref<Row>(env, org, "rules:general", {}),
    country = String(general.defaultPhoneCountry || "IN") as CountryCode;
  let phone;
  try {
    phone = parsePhoneNumberFromString(String(value || ""), country);
  } catch {}
  ensure(phone && phone.isPossible(), "Enter a valid phone number with country code");
  return phone.number;
}
