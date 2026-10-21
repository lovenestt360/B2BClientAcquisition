import { prisma } from "@/lib/db";
import { getBoss, QUEUE_POLICIES, runJob, runScheduled } from "@/server/jobs";
import type { QueueName } from "@/server/jobs/handlers";

async function main() {
  const boss = await getBoss();
  for (const queue of Object.keys(QUEUE_POLICIES)) {
    await boss.work<{ jobRecordId?: string }>(queue, async (jobs) => {
      for (const job of jobs) {
        if (job.data?.jobRecordId) await runJob(prisma, job.data.jobRecordId);
        // Scheduled (cron) jobs arrive without a record: create one, keyed per run.
        else await runScheduled(prisma, queue as QueueName, `${queue}:${job.id}`);
      }
    });
    console.log(`[worker] listening on ${queue}`);
  }
  // Inbox sync for every enabled real mailbox, every 5 minutes.
  await boss.schedule("email.sync_all", "*/5 * * * *", {}, { tz: process.env.APP_TIMEZONE ?? "Africa/Johannesburg" });
  console.log("[worker] scheduled email.sync_all every 5 minutes");

  const shutdown = async () => {
    console.log("[worker] shutting down");
    await boss.stop({ graceful: true });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
