import type { PrismaClient } from "@prisma/client";
import { seedProviderRows } from "../src/server/providers/registry";

export async function seedProviders(prisma: PrismaClient) {
  await seedProviderRows(prisma, { simulation: process.env.SIMULATION_MODE !== "false" });
  if (!(await prisma.voiceAgentConfig.count())) {
    await prisma.voiceAgentConfig.create({
      data: {
        name: "AI sales caller",
        persona: "A friendly, concise business development assistant for a South African B2B services company.",
        instructions:
          "Main objective: book a short meeting. Be warm and confident, listen, tie the offer to what the lead says, and propose concrete times. Accept a clear no gracefully. If asked to stop, apologise and end the call.",
        disclosureText: "Hi {name}, this is an AI assistant calling on behalf of {owner} at {business}, speaking in {owner}'s voice.",
      },
    });
  }
}
