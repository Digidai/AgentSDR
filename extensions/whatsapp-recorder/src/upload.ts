/**
 * Reporting a call to the app and putting its recording in R2, from the
 * service worker (background.ts, for the recordings wa-agent hands it).
 * Extension contexts with host permissions, so no CORS is involved.
 */

import type {
  FinishCallRequest,
  RecorderCallStatus,
  UploadUrlRequest,
  UploadUrlResponse,
} from "../../../src/lib/calls/contract";
import type { ActiveCall } from "./messages";

/** All a report needs: where to send it, and the call's own token. */
type ReportableCall = Pick<ActiveCall, "apiBase" | "callId" | "recorderToken">;

/**
 * Uploads a recording running startedAt → endedAt and reports the call
 * finished. The lead picked up at answeredAt: the call's start and talk time
 * are from there, and the ringing before it is the recording's offset.
 */
export async function uploadRecording(
  call: ReportableCall,
  blob: Blob,
  startedAt: number,
  endedAt: number,
  answeredAt: number = startedAt,
): Promise<void> {
  const request: UploadUrlRequest = {
    contentType: blob.type,
    bytes: blob.size,
  };
  const { uploadUrl, recordingKey, headers, multipart } =
    await callApi<UploadUrlResponse>(call, "upload-url", request);

  if (multipart) {
    const parts: { partNumber: number; etag: string }[] = [];
    for (
      let start = 0, part = 1;
      start < blob.size;
      start += multipart.partSize, part++
    ) {
      const url = new URL(uploadUrl);
      url.searchParams.set("part", String(part));
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: blob.slice(start, start + multipart.partSize),
      });
      if (!response.ok)
        throw new Error(`storage part ${part} answered ${response.status}`);
      parts.push(
        (await response.json()) as { partNumber: number; etag: string },
      );
    }
    const completed = await fetch(multipart.completeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    });
    if (!completed.ok)
      throw new Error(`storage completion answered ${completed.status}`);
  } else {
    const put = await fetch(uploadUrl, { method: "PUT", headers, body: blob });
    if (!put.ok) throw new Error(`storage answered ${put.status}`);
  }

  const finish: FinishCallRequest = {
    outcome: "recorded",
    recordingKey,
    bytes: blob.size,
    contentType: blob.type,
    startedAt: new Date(answeredAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, endedAt - answeredAt),
    recordingOffsetMs: Math.max(0, answeredAt - startedAt),
  };
  await callApi(call, "finish", finish);
}

/** GET /api/call-recorder/calls/:id — the transcript's progress, for the call card. */
export async function getCallStatus(
  call: Pick<ActiveCall, "apiBase" | "callId" | "recorderToken">,
): Promise<RecorderCallStatus> {
  const response = await fetch(
    `${call.apiBase}/api/call-recorder/calls/${call.callId}`,
    {
      headers: { Authorization: `Bearer ${call.recorderToken}` },
    },
  );
  if (!response.ok) throw new Error(`status answered ${response.status}`);
  return (await response.json()) as RecorderCallStatus;
}

/** POSTs to /api/call-recorder/calls/:id/<action> with the call's token. */
export async function callApi<T = unknown>(
  call: ReportableCall,
  action: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(
    `${call.apiBase}/api/call-recorder/calls/${call.callId}/${action}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.recorderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(detail?.error ?? `${action} answered ${response.status}`);
  }
  return (await response.json()) as T;
}
