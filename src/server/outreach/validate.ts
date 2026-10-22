import type { GenerationInput, GenerationOutput } from "./generate";
import type { Exposure, OutreachSettings } from "./config";

export type Decision = "APPROVE" | "HOLD" | "RESEARCH_REQUIRED";

export interface ValidationResult {
  decision: Decision;
  reasons: string[]; // CODE: detail
  warnings: string[];
  wordCount: number;
  links: string[];
}

const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "lnkd.in", "shorturl.at", "tiny.cc"];
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,}\d{3,4}/g;
const URGENCY_RE = /\b(urgent|asap|immediately|final notice|last chance|act now|deadline|today only|important notice|action required|time[- ]sensitive)\b/i;
const FAKE_PRIOR_RE = /\b(as (we )?discussed|following (up on )?our (call|conversation|meeting)|per our (call|conversation)|thanks? (you )?for (your|getting back)|as promised|you (asked|requested) (me|us))\b/i;
const INSIDE_RE = [
  /\byour (recent|current|ongoing|latest) (delays?|claims?|disputes?|rework|failures?|problems?|issues?|overruns?)\b/i,
  /\b(you|your team|your company) (had|have had|faced|have faced|suffered|missed|lost|are facing)\b/i,
  /\bI (noticed|saw|heard|understand) (that )?(you|your)\b/i,
];
const WEAK_CTA_RE = /\b(learn more|interested in a call|discuss our (bim )?services|show you what we do|hop on a call)\b/i;
const GUARANTEE_RE = /\b(guarantee[sd]?|ensures? zero|eliminates? all|never again|100 ?%)\b/i;

/** Capitalised words that are ordinary English at a sentence start. */
const COMMON = new Set(
  "a an and are as at be but by can could did do does each even every for from had has have he her his how i if in into is it its just let many may me more most my no not now of on once one or our out over so some such that the their them then there these they this those though to too up us was we were what when where which while who why will with would yes you your hi hello dear good morning afternoon kind regards thanks thank best monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december south africa african bim mep qa qc rfi".split(
    " ",
  ),
);

const words = (s: string) => s.match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9'’&.-]*/g) ?? [];
const norm = (s: string) => s.toLowerCase().replace(/[’']s$/, "").replace(/[.,;:!?)]+$/, "");

function trigrams(s: string): Set<string> {
  const w = words(s.toLowerCase());
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function hostAllowed(host: string, domains: string[]) {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Check a generated email against the lead's evidence and the outreach rules. The model's own
 * claims (evidence IDs, decision) are inputs to check, never proof.
 */
export function validateOutreachEmail(
  out: GenerationOutput,
  input: GenerationInput,
  settings: Pick<OutreachSettings, "approvedLinkDomains" | "bookingUrl" | "bannedClaims" | "wordRange" | "meetingMinutes" | "signature" | "businessName" | "senderName" | "brandLine" | "capabilities">,
  exposures: Exposure[],
): ValidationResult {
  const reasons: string[] = [];
  const research: string[] = [];
  const warnings: string[] = [];
  const subject = out.subject.trim();
  // The model must not add our signature/footer; strip it if it did so the checks see only its text.
  const sigLines = new Set(settings.signature.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
  const body = out.body
    .split("\n")
    .filter((l) => !sigLines.has(l.trim().toLowerCase()) && !/unsubscribe/i.test(l))
    .join("\n")
    .trim();

  // ── Model's own decision ──
  if (out.decision === "RESEARCH_REQUIRED") research.push(`MODEL_RESEARCH_REQUIRED: ${out.riskFlags.join("; ") || "model asked for more research"}`);
  if (out.decision === "HOLD") reasons.push(`MODEL_HOLD: ${out.riskFlags.join("; ") || "model held the message"}`);
  if (out.decision === "APPROVE" && out.riskFlags.length) reasons.push(`MODEL_RISK_FLAGS: ${out.riskFlags.join("; ")}`);
  if (out.decision !== "APPROVE") return finish();

  // ── Evidence ──
  const evidence = input.verifiedResearch;
  if (!evidence.some((e) => e.kind === "need_evidence")) research.push("NO_NEED_EVIDENCE: no verified need evidence for this lead");
  const known = new Set(evidence.map((e) => e.id));
  const unknownIds = out.supportingEvidenceIds.filter((id) => !known.has(id));
  if (unknownIds.length) reasons.push(`UNKNOWN_EVIDENCE_ID: ${unknownIds.join(", ")} not in this lead's verified research`);
  if (!out.supportingEvidenceIds.length) research.push("NO_SUPPORTING_EVIDENCE: the email cites no verified research");

  // Vocabulary the email may use for names and numbers: this lead's evidence + approved wording.
  const exp = exposures.find((e) => e.id === out.chosenCommercialExposure);
  const approvedText = [
    ...evidence.map((e) => `${e.field} ${e.value}`),
    input.lead.firstName,
    input.lead.lastName ?? "",
    input.lead.company ?? "",
    input.lead.sector ?? "",
    input.lead.city ?? "",
    input.lead.title ?? "",
    settings.businessName,
    settings.senderName,
    settings.brandLine,
    ...settings.capabilities.map((c) => c.text),
    ...exposures.flatMap((e) => [e.label, e.consequence, e.stake, e.prevention, e.subjectTopic]),
  ].join(" ");
  const vocab = new Set(words(approvedText).map(norm));
  const text = `${subject}\n${body}`.replace(URL_RE, " ");

  // Proper nouns: capitalised words not explained by evidence, approved wording or plain English.
  const unsupported = new Set<string>();
  for (const w of words(text)) {
    if (!/^[A-ZÀ-Ý]/.test(w)) continue;
    const n = norm(w);
    if (vocab.has(n) || COMMON.has(n)) continue;
    unsupported.add(w.replace(/[.,;:!?]+$/, ""));
  }
  if (unsupported.size) reasons.push(`UNSUPPORTED_REFERENCE: ${[...unsupported].join(", ")} not found in this lead's research`);

  // Numbers: only the meeting length or numbers that appear in the evidence.
  const evidenceNumbers = new Set(approvedText.match(/\d[\d,.]*/g)?.map((x) => x.replace(/[.,]$/, "")) ?? []);
  const nums = (text.match(/\d[\d,.]*%?/g) ?? []).map((x) => x.replace(/[.,]$/, "")).filter((x) => x !== String(settings.meetingMinutes) && !evidenceNumbers.has(x.replace(/%$/, "")));
  if (nums.length) reasons.push(`UNSUPPORTED_NUMBER: ${[...new Set(nums)].join(", ")}`);

  // Recipient and company references
  const greet = /^(?:hi|hello|dear|good (?:morning|afternoon))\s+([^\s,]+)/i.exec(body);
  if (!greet) warnings.push("no greeting with the recipient's first name");
  else if (norm(greet[1]) !== norm(input.lead.firstName)) reasons.push(`WRONG_RECIPIENT: greets "${greet[1]}" but the lead is ${input.lead.firstName}`);

  // Inside knowledge / invented events
  for (const re of INSIDE_RE) {
    const m = re.exec(body);
    if (m) reasons.push(`ASSERTS_UNVERIFIED_EVENT: "${m[0]}"`);
  }
  if (GUARANTEE_RE.test(`${subject} ${body}`)) reasons.push("UNSUPPORTED_GUARANTEE");

  // ── Meeting CTA ──
  const sentences = body.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const m = settings.meetingMinutes;
  const meetingRe = new RegExp(`\\b${m}[ -]?(minutes?|mins?)\\b${m === 15 ? "|\\bfifteen[ -]?minutes?\\b" : ""}`, "i");
  const ctaSentences = sentences.filter((s) => meetingRe.test(s));
  if (ctaSentences.length === 0) reasons.push(`NO_MEETING_CTA: no ${settings.meetingMinutes}-minute meeting invitation`);
  if (ctaSentences.length > 1) reasons.push("MULTIPLE_CTAS: more than one meeting request");
  const otherAsks = sentences.filter((s) => s.endsWith("?") && !ctaSentences.includes(s) && /\b(call|meeting|chat|talk|discuss|demo)\b/i.test(s));
  if (otherAsks.length) reasons.push("MULTIPLE_CTAS: competing call-to-action");
  if (WEAK_CTA_RE.test(body)) reasons.push("WEAK_CTA: generic ask instead of a specific meeting reason");
  if (!body.includes(out.meetingCta.trim().slice(0, 40))) warnings.push("meetingCta field does not match the body");

  // ── Subject ──
  if (/^\s*(re|fw|fwd|aw)\s*:/i.test(subject)) reasons.push("MISLEADING_SUBJECT: forged reply/forward prefix");
  if (subject.length > 70) reasons.push("SUBJECT_TOO_LONG: over 70 characters");
  if (URGENCY_RE.test(subject)) reasons.push("MISLEADING_SUBJECT: fake urgency");
  if (/!/.test(subject)) reasons.push("MISLEADING_SUBJECT: exclamation mark");
  if (FAKE_PRIOR_RE.test(subject)) reasons.push("MISLEADING_SUBJECT: implies prior contact");
  if ((subject.match(/\b[A-Z]{4,}\b/g) ?? []).some((w) => !vocab.has(norm(w)))) reasons.push("MISLEADING_SUBJECT: shouting capitals");
  if (/\[[^\]]+\]/.test(`${subject} ${body}`)) reasons.push("PLACEHOLDER_LEFT: bracketed placeholder text");

  // ── Body claims ──
  if (FAKE_PRIOR_RE.test(body)) reasons.push("IMPLIES_PRIOR_CONTACT");
  if (URGENCY_RE.test(body)) reasons.push("FAKE_URGENCY");
  const lower = `${subject}\n${body}`.toLowerCase();
  for (const b of settings.bannedClaims) if (b && lower.includes(b.toLowerCase())) reasons.push(`BANNED_CLAIM: "${b}"`);

  // ── Links and contact details ──
  const links = [...new Set(`${subject}\n${body}`.match(URL_RE) ?? [])].map((l) => l.replace(/[.,;:!?)]+$/, ""));
  if (links.length > 1) reasons.push("MULTIPLE_LINKS: at most one link");
  for (const l of links) {
    if (!/^https:\/\//i.test(l)) {
      reasons.push(`LINK_NOT_HTTPS: ${l}`);
      continue;
    }
    let host = "";
    try {
      host = new URL(l).hostname;
    } catch {
      reasons.push(`LINK_INVALID: ${l}`);
      continue;
    }
    if (SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) reasons.push(`LINK_SHORTENER: ${l}`);
    else if (!hostAllowed(host, settings.approvedLinkDomains)) reasons.push(`LINK_NOT_APPROVED: ${host}`);
    else if (settings.bookingUrl && host === new URL(settings.bookingUrl).hostname && !l.startsWith(settings.bookingUrl.replace(/\/$/, ""))) reasons.push(`LINK_NOT_APPROVED: ${l} is not the approved booking URL`);
  }
  const emails = (body.match(EMAIL_RE) ?? []).filter((e) => !links.some((l) => l.includes(e)));
  if (emails.length) reasons.push(`CONTACT_DETAILS: email address in body (${emails.join(", ")})`);
  if ((body.replace(URL_RE, " ").match(PHONE_RE) ?? []).some((p) => p.replace(/\D/g, "").length >= 9)) reasons.push("CONTACT_DETAILS: phone number in body");

  // ── Length ──
  const wordCount = words(body.replace(URL_RE, " ")).length;
  const wr = settings.wordRange;
  if (wordCount < wr.hardMin || wordCount > wr.hardMax) reasons.push(`WORD_COUNT: ${wordCount} words (allowed ${wr.hardMin}-${wr.hardMax})`);
  else if (wordCount < wr.min || wordCount > wr.max) warnings.push(`${wordCount} words; preferred ${wr.min}-${wr.max}`);

  // ── Distinct from earlier steps ──
  for (const p of input.priorMessages) {
    if (p.exposure && p.exposure === out.chosenCommercialExposure) reasons.push(`REPEATED_EXPOSURE: step ${p.step} already argued ${p.exposure}`);
    if (p.subject.trim().toLowerCase() === subject.toLowerCase()) reasons.push(`REPEATED_SUBJECT: same subject as step ${p.step}`);
    const sim = jaccard(trigrams(p.body), trigrams(body));
    if (sim > 0.35) reasons.push(`TOO_SIMILAR_TO_PRIOR: ${Math.round(sim * 100)}% overlap with step ${p.step}`);
  }
  if (!exp && !input.priorMessages.length) warnings.push("exposure is not from the approved library");

  return finish(wordCount, links);

  function finish(wordCount = 0, links: string[] = []): ValidationResult {
    const decision: Decision = research.length ? "RESEARCH_REQUIRED" : reasons.length ? "HOLD" : "APPROVE";
    return { decision, reasons: [...research, ...reasons], warnings, wordCount, links };
  }
}
