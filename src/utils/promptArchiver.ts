// amplify/functions/workflow-runner/src/utils/promptArchiver.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export type FinalRole = "system" | "user" | "assistant" | "tool";
export type LogRole = FinalRole | "unknown";

export interface PromptLine {
  role: LogRole;
  content: string;
}

export interface PromptArchivePayload {
  workflowId: string;
  conversationId: string;
  modelId: string;
  stepId?: string;
  pointerId?: string | null;
  basePromptVersionId?: string | null;
  totalTokens: number;
  wasTruncated: boolean;
  createdAtIso: string;
  lines: PromptLine[];
}

/** Basic PII redaction (email, phone). Extend as needed. */
function redact(text: string): string {
  if (process.env.PROMPT_ARCHIVE_REDACT !== "1") return text;
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g, "[REDACTED_PHONE]");
}

function safeString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

const toRole = (r: unknown): LogRole =>
  r === "system" || r === "user" || r === "assistant" || r === "tool" ? r : "unknown";

/**
 * Convert provider/BaseMessage-like objects to compact, capped lines.
 */
export function toLines(
  messages: ReadonlyArray<unknown>,
  maxLines: number,
  maxChars: number
): PromptLine[] {
  return messages.slice(0, maxLines).map((m) => {
    const obj = (typeof m === "object" && m !== null) ? (m as Record<string, unknown>) : undefined;
    const c = obj?.content;
    let contentRaw: string;
    if (typeof c === "string") {
      contentRaw = c;
    } else if (Array.isArray(c)) {
      // Join text parts for cleaner archiving
      contentRaw = c
        .map((part) => {
          const t = (part as { text?: unknown })?.text;
          return typeof t === "string" ? t : "";
        })
        .filter(Boolean)
        .join("");
    } else {
      contentRaw = safeString(c ?? m);
    }
    const capped = contentRaw.slice(0, maxChars);
    return { role: toRole(obj?.role), content: redact(capped) };
  });
}

/**
 * Persist a single prompt archive blob to S3.
 * Layout: prompt-archive/YYYY/MM/DD/<workflowId>/<conversationId>/<timestamp>-<step>.json
 */
export async function archivePromptToS3(payload: PromptArchivePayload): Promise<{ key: string }> {
  const bucket = process.env.PROMPT_ARCHIVE_BUCKET;
  if (!bucket) throw new Error("PROMPT_ARCHIVE_BUCKET not set");

  const dt = new Date(payload.createdAtIso);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const ts = dt.toISOString().replace(/[:.]/g, "-");

  const key = [
    "prompt-archive",
    yyyy, mm, dd,
    payload.workflowId,
    payload.conversationId,
    `${ts}-${payload.stepId ?? "model"}.json`,
  ].join("/");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(payload),
    ContentType: "application/json",
    // Enforce CMK encryption explicitly (bucket also defaults to CMK)
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: process.env.PROMPT_CONTENT_KMS_KEY_ARN ?? process.env.PROMPT_CONTENT_KMS_KEY_ID,
    ChecksumAlgorithm: "SHA256",
  }));

  return { key };
}