import { app } from "./api";
import { processJob, tick } from "./jobs";
import type { Env } from "./types";
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(tick(env));
  },
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    for (const message of batch.messages) {
      try {
        await processJob(env, message.body.id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, { id: string }>;
