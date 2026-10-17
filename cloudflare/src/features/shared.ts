import { HTTPException } from "hono/http-exception";
import type { Ctx, Env, Row } from "../types";
import { id, json, now } from "../core";
export function ensure(
  value: unknown,
  message: string,
  status: 400 | 403 | 404 | 409 = 400,
): asserts value {
  if (!value) throw new HTTPException(status, { message });
}
export async function record(
  env: Env,
  org: string,
  table: string,
  key: string | undefined,
) {
  ensure(key, "Record not found", 404);
  const found = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id=? AND org_id=?`,
  )
    .bind(key, org)
    .first<Row>();
  ensure(found, "Record not found", 404);
  return found;
}
export async function pref<T = Row>(
  env: Env,
  org: string,
  key: string,
  fallback: T = {} as T,
): Promise<T> {
  const row = await env.DB.prepare(
    "SELECT value FROM preferences WHERE org_id=? AND key=?",
  )
    .bind(org, key)
    .first<{ value: string }>();
  return json(row?.value, fallback);
}
export async function savePref(
  env: Env,
  org: string,
  key: string,
  value: unknown,
) {
  await env.DB.prepare(
    "INSERT INTO preferences(org_id,key,value) VALUES(?,?,?) ON CONFLICT(org_id,key) DO UPDATE SET value=excluded.value,updated_at=?",
  )
    .bind(org, key, JSON.stringify(value), now())
    .run();
}
export const orgId = (c: Ctx) => c.get("user").org_id;
export async function batches(env: Env, statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += 50)
    await env.DB.batch(statements.slice(i, i + 50));
}
export async function addAudit(
  env: Env,
  org: string,
  type: string,
  detail: string,
  person: string | null = null,
) {
  await env.DB.prepare(
    "INSERT INTO events(id,org_id,type,detail,person_id) VALUES(?,?,?,?,?)",
  )
    .bind(id(), org, type, detail, person)
    .run();
}
export function convertField(
  value: unknown,
  type: string,
): { value: unknown; compatible: boolean } {
  if (value === null || value === undefined || value === "")
    return { value: null, compatible: true };
  if (type === "number" || type === "currency")
    return {
      value: Number.isFinite(Number(value)) ? Number(value) : null,
      compatible: Number.isFinite(Number(value)),
    };
  if (type === "boolean") {
    const v = String(value).toLowerCase();
    return {
      value: ["true", "1"].includes(v)
        ? true
        : ["false", "0"].includes(v)
          ? false
          : null,
      compatible: ["true", "false", "0", "1"].includes(v),
    };
  }
  if (type === "date") {
    const n = Date.parse(String(value));
    return {
      value: Number.isFinite(n) ? new Date(n).toISOString() : null,
      compatible: Number.isFinite(n),
    };
  }
  if (type === "json") return { value, compatible: true };
  if (type === "multiselect")
    return {
      value: Array.isArray(value)
        ? value.map(String)
        : String(value)
            .split(",")
            .map((v) => v.trim()),
      compatible: true,
    };
  return { value: String(value), compatible: true };
}
export async function purgePersonMedia(env: Env, org: string, pid: string) {
  const person = await record(env, org, "people", pid),
    photo = json<Row>(person.custom, {}).photo_key;
  if (photo) await env.MEDIA.delete(photo);
  const files = await env.DB.prepare(
    "SELECT object_key FROM files WHERE org_id=? AND person_id=?",
  )
    .bind(org, pid)
    .all<Row>();
  for (const f of files.results) await env.MEDIA.delete(f.object_key);
  const calls = await env.DB.prepare(
    "SELECT id,recording_key,upload_id FROM calls WHERE org_id=? AND person_id=?",
  )
    .bind(org, pid)
    .all<Row>();
  for (const c of calls.results) {
    if (c.recording_key) await env.MEDIA.delete(c.recording_key);
    if (c.upload_id)
      try {
        await env.MEDIA.resumeMultipartUpload(
          `${org}/recordings/${c.id}.webm`,
          c.upload_id,
        ).abort();
      } catch {
        /* A completed upload no longer has multipart state. */
      }
  }
}
