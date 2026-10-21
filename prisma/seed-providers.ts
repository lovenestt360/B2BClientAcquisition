import type { PrismaClient } from "@prisma/client";
import { seedProviderRows } from "../src/server/providers/registry";

export async function seedProviders(prisma: PrismaClient) {
  await seedProviderRows(prisma, { simulation: process.env.SIMULATION_MODE !== "false" });
  if (!(await prisma.voiceAgentConfig.count())) {
    await prisma.voiceAgentConfig.create({
      data: {
        name: "Sandbox discovery agent",
        persona: "A friendly, concise business development assistant for a South African B2B services company.",
        instructions:
          "Introduce the company in one sentence, ask whether the contact is the right person for operations decisions, ask one discovery question about their current challenges, and offer to book a 20-minute meeting. Never pressure. If asked to stop, apologise and end the call.",
        disclosureText: "Hi, this is an AI assistant calling on behalf of {business}. This is a simulated call for testing.",
      },
    });
  }
}
