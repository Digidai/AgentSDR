import type { Context } from "hono";
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  TASKS: Queue<{ id: string }>;
  AI: Ai;
  ASSETS: Fetcher;
  APP_URL: string;
  ENCRYPTION_KEY: string;
  UNSUBSCRIBE_SECRET: string;
  BOOTSTRAP_TOKEN: string;
  AI_MODEL: string;
  RELEASE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
}
export interface Identity {
  id: string;
  email: string;
  name: string;
  org_id: string;
  role: "owner" | "admin" | "member";
}
export type AppEnv = { Bindings: Env; Variables: { user: Identity } };
export type Ctx = Context<AppEnv>;
export type Row = Record<string, any>;
export interface Column {
  key: string;
  name: string;
  type: string;
  prompt?: string;
  url?: string;
  path?: string;
  config?: Record<string, any>;
}
