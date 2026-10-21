import Link from "next/link";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { ActionForm, Field } from "@/components/ActionForm";
import { Empty, ModeBadge, PageHeader, fmtDate } from "@/components/ui";
import { VoiceSandbox } from "@/components/voice/VoiceSandbox";
import { voiceAgentAction } from "@/app/actions/outreach";

export default async function VoicePage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const user = await requireUser();
  const { edit } = await searchParams;
  const e = env();
  const [agents, sandbox, sip, sessions] = await Promise.all([
    prisma.voiceAgentConfig.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.providerConfig.findUnique({ where: { key: "local_ai_sandbox" } }),
    prisma.providerConfig.findUnique({ where: { key: "asterisk_sip_ai" } }),
    prisma.call.findMany({ where: { providerKey: "local_ai_sandbox" }, orderBy: { createdAt: "desc" }, take: 10, include: { _count: { select: { transcripts: true } } } }),
  ]);
  const editing = agents.find((a) => a.id === edit) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="AI voice" subtitle="Local sandbox only. Automated telephone calling is disabled.">
        <ModeBadge mode="SIMULATED" />
      </PageHeader>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="card text-sm"><p className="font-medium">LLM</p><p className="muted">{e.LLM_PROVIDER === "ollama" ? `Ollama · ${e.OLLAMA_MODEL}` : "Mock (set LLM_PROVIDER=ollama)"}</p></div>
        <div className="card text-sm"><p className="font-medium">Speech recognition</p><p className="muted">{e.STT_PROVIDER === "http" ? `faster-whisper @ ${e.STT_URL}` : "Mock (type replies)"}</p></div>
        <div className="card text-sm"><p className="font-medium">Speech synthesis</p><p className="muted">{e.TTS_PROVIDER === "http" ? `Chatterbox @ ${e.TTS_URL}` : "Browser voice (mock)"}</p></div>
      </div>

      <section className="card" aria-labelledby="sb">
        <h2 id="sb" className="mb-2 font-semibold">Sandbox conversation</h2>
        {!sandbox?.enabled ? <Empty>The local AI sandbox provider is disabled.</Empty> : agents.length === 0 ? <Empty>Create a voice agent below.</Empty> : (
          <VoiceSandbox agents={agents.map((a) => ({ id: a.id, name: a.name }))} sttEnabled={e.STT_PROVIDER === "http"} ttsEnabled={e.TTS_PROVIDER === "http"} />
        )}
      </section>

      <section className="card text-sm" aria-labelledby="sip">
        <h2 id="sip" className="font-semibold">Automated telephone calling (Asterisk SIP)</h2>
        <p className="mt-1">
          Status: <strong>{sip?.enabled ? "enabled" : "disabled"}</strong> · authorisation: <strong>{sip?.carrierAuthorized ? sip.carrierAuthRef : "none recorded"}</strong> · environment gate:{" "}
          <strong>{e.ALLOW_AUTOMATED_OUTREACH ? "open" : "closed"}</strong>
        </p>
        <p className="muted mt-1">
          Needs a business SIP trunk from a licensed operator that authorises AI calling. Never connect your Telkom consumer SIM to a PBX. See docs/VOICE.md.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 font-semibold">Voice agents</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2">
                <span>{a.name} <span className="text-xs text-slate-500">{a.llmModel}{a.ttsVoiceRef ? ` · voice: ${a.ttsVoiceRef}` : ""}</span></span>
                {can(user.role, "providers.manage") && <Link className="text-xs text-brand-700" href={`/voice?edit=${a.id}`}>Edit</Link>}
              </li>
            ))}
          </ul>
          <h3 className="mb-1 mt-4 text-sm font-semibold">Recent sandbox sessions</h3>
          <ul className="text-sm">
            {sessions.map((s) => <li key={s.id}><Link className="text-brand-700" href={`/calls/${s.id}`}>{fmtDate(s.createdAt)}</Link> <span className="muted">· {s._count.transcripts} turns · {s.notes ?? s.status.toLowerCase()}</span></li>)}
          </ul>
        </div>
        {can(user.role, "providers.manage") && (
          <div className="card">
            <h2 className="mb-2 font-semibold">{editing ? `Edit ${editing.name}` : "New voice agent"}</h2>
            <ActionForm action={voiceAgentAction} submitLabel="Save agent" key={editing?.id ?? "new"}>
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <Field label="Name" name="name" required defaultValue={editing?.name} />
              <div><label className="label" htmlFor="persona">Persona</label><textarea className="input" id="persona" name="persona" rows={2} required defaultValue={editing?.persona} /></div>
              <div><label className="label" htmlFor="instructions">Call instructions</label><textarea className="input" id="instructions" name="instructions" rows={3} required defaultValue={editing?.instructions} /></div>
              <Field label='AI disclosure (must say "AI"; {business} is replaced)' name="disclosureText" required defaultValue={editing?.disclosureText ?? "Hi, this is an AI assistant calling on behalf of {business}."} />
              <Field label="Ollama model" name="llmModel" defaultValue={editing?.llmModel ?? "llama3.1:8b"} />
              <Field label="Chatterbox voice reference file (optional, e.g. my-voice.wav)" name="ttsVoiceRef" defaultValue={editing?.ttsVoiceRef ?? ""} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="voiceOwnerConsent" defaultChecked={editing?.voiceOwnerConsent} className="mt-1 h-5 w-5" />
                <span>I confirm the reference voice is my own, or I hold the speaker&apos;s written permission to clone it.</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Silence (ms)" name="silenceTimeoutMs" type="number" defaultValue={String(editing?.silenceTimeoutMs ?? 6000)} />
                <Field label="Reprompts" name="maxSilenceReprompts" type="number" defaultValue={String(editing?.maxSilenceReprompts ?? 2)} />
                <Field label="Max turns" name="maxTurns" type="number" defaultValue={String(editing?.maxTurns ?? 30)} />
              </div>
            </ActionForm>
          </div>
        )}
      </section>
    </div>
  );
}
