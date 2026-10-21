import { prisma } from "@/lib/db";
import { getBoss, QUEUE_POLICIES, runJob } from "@/server/jobs";

async function main() {
  const boss = await getBoss();
  for (const queue of Object.keys(QUEUE_POLICIES)) {
    await boss.work<{ jobRecordId: string }>(queue, async (jobs) => {
      for (const job of jobs) await runJob(prisma, job.data.jobRecordId);
    });
    console.log(`[worker] listening on ${queue}`);
  }
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
