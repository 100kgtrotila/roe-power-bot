import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

import { beforeEach } from "vitest";

// The runtime database is local to this test worker. Reset rows explicitly between tests.
beforeEach(async () => {
  await env.DB.batch(
    [
      "deliveries",
      "notification_state",
      "reminder_receipts",
      "subscribers",
      "schedule_snapshots",
      "source_state",
      "operations",
      "leases",
      "scheduler_state",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
