import { getStore } from "@netlify/blobs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STORE_NAME = process.env.INTAKE_STORE_NAME || "submissions";
const API_TOKEN = process.env.INTAKE_API_TOKEN || "";
const DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://localhost:3001,http://localhost:5000,http://localhost:8888";
const LOCAL_STORE_PATH = process.env.INTAKE_LOCAL_STORE_PATH || ".data/submissions.json";

function corsOrigins() {
  return (process.env.INTAKE_API_CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(event) {
  const origin = event.headers.origin || event.headers.Origin || "";
  const origins = corsOrigins();
  const allowOrigin = origin && (origins.includes(origin) || origins.includes("*")) ? origin : origins.includes("*") ? "*" : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

function response(event, statusCode, body = {}) {
  return {
    statusCode,
    headers: corsHeaders(event),
    body: statusCode === 204 ? "" : JSON.stringify(body),
  };
}

async function requestToEvent(request) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  return {
    body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
    headers,
    httpMethod: request.method,
    isBase64Encoded: false,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    rawUrl: request.url,
  };
}

function toWebResponse(result) {
  return new Response(result.statusCode === 204 ? null : result.body || "", {
    status: result.statusCode,
    headers: result.headers || {},
  });
}

function unauthorized(event) {
  return response(event, 401, { error: "unauthorized" });
}

function isAuthorized(event) {
  if (!API_TOKEN) {
    return true;
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  return authHeader === `Bearer ${API_TOKEN}`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizePath(event) {
  const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || "";
  const match = path.match(/\/submissions\/?(.*)$/);
  const rest = match ? match[1] : "";
  return rest.split("/").filter(Boolean).map(decodeURIComponent);
}

function submissionIdFromPath(event) {
  const segments = normalizePath(event);
  return segments[0] || "";
}

function isDecisionPath(event) {
  const segments = normalizePath(event);
  return segments.length === 2 && segments[1] === "decision";
}

function contributorPayload(payload) {
  const nextPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  nextPayload.contrubution_source = nextPayload.contrubution_source || "contributor";
  return nextPayload;
}

function publicSubmission(submission) {
  return submission;
}

function compareUpdatedDesc(a, b) {
  return String(b.updated_at || b.submitted_at || "").localeCompare(String(a.updated_at || a.submitted_at || ""));
}

async function readLocalStore() {
  try {
    return JSON.parse(await readFile(LOCAL_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeLocalStore(items) {
  await mkdir(dirname(LOCAL_STORE_PATH), { recursive: true });
  await writeFile(LOCAL_STORE_PATH, JSON.stringify(items, null, 2));
}

function getLocalStore() {
  return {
    async list() {
      const items = await readLocalStore();
      return {
        blobs: Object.keys(items).map((key) => ({ key })),
      };
    },
    async get(key) {
      const items = await readLocalStore();
      return items[key] || null;
    },
    async setJSON(key, value) {
      const items = await readLocalStore();
      items[key] = value;
      await writeLocalStore(items);
      return { modified: true };
    },
    async delete(key) {
      const items = await readLocalStore();
      delete items[key];
      await writeLocalStore(items);
    },
    async deleteAll() {
      try {
        await unlink(LOCAL_STORE_PATH);
      } catch {}
    },
  };
}

function getSubmissionStore() {
  if (process.env.INTAKE_STORAGE_DRIVER === "file") {
    return getLocalStore();
  }
  return getStore(STORE_NAME);
}

async function listSubmissions(store) {
  const listed = await store.list();
  const submissions = [];
  for (const blob of listed.blobs || []) {
    const item = await store.get(blob.key, { type: "json" });
    if (item) {
      submissions.push(item);
    }
  }
  return submissions;
}

async function findSubmission(store, submissionId) {
  if (!submissionId) {
    return null;
  }
  return store.get(submissionId, { type: "json" });
}

async function nextSubmissionId(store) {
  const submissions = await listSubmissions(store);
  const existing = new Set(submissions.map((item) => item.id).filter((id) => String(id || "").startsWith("sub-")));
  let index = existing.size + 1001;
  while (existing.has(`sub-${index}`)) {
    index += 1;
  }
  return `sub-${index}`;
}

async function saveSubmission(store, submission) {
  await store.setJSON(submission.id, submission, {
    metadata: {
      status: submission.status || "",
      updated_at: submission.updated_at || "",
    },
  });
  return submission;
}

async function handleList(event, store) {
  const status = event.queryStringParameters?.status || "";
  let items = await listSubmissions(store);
  if (status) {
    items = items.filter((item) => item.status === status);
  }
  items = items.sort(compareUpdatedDesc).map(publicSubmission);
  return response(event, 200, { items });
}

async function handleCreate(event, store) {
  const input = parseBody(event);
  const timestamp = nowIso();
  const submission = {
    id: await nextSubmissionId(store),
    status: input.status || "submitted",
    submitter_email: input.submitter_email || "",
    submitter_name: input.submitter_name || "",
    submitter_username: input.submitter_username || "",
    submitter_id: input.submitter_id || "",
    source: input.source || "",
    submitted_at: timestamp,
    updated_at: timestamp,
    payload_json: contributorPayload(input.payload_json || input.payload || {}),
  };
  await saveSubmission(store, submission);
  return response(event, 201, publicSubmission(submission));
}

async function handleGet(event, store, submissionId) {
  const submission = await findSubmission(store, submissionId);
  if (!submission) {
    return response(event, 404, { error: "not_found" });
  }
  return response(event, 200, publicSubmission(submission));
}

async function handleDelete(event, store, submissionId) {
  const submission = await findSubmission(store, submissionId);
  if (!submission) {
    return response(event, 404, { error: "not_found" });
  }
  await store.delete(submissionId);
  return response(event, 204);
}

async function handleUpdate(event, store, submissionId) {
  const submission = await findSubmission(store, submissionId);
  if (!submission) {
    return response(event, 404, { error: "not_found" });
  }
  const input = parseBody(event);
  if (Object.prototype.hasOwnProperty.call(input, "payload_json")) {
    submission.payload_json = contributorPayload(input.payload_json);
  }
  if (input.status) {
    submission.status = input.status;
  }
  for (const key of ["submitter_email", "submitter_name", "submitter_username", "submitter_id"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      submission[key] = input[key] || "";
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "source")) {
    submission.source = input.source || "";
  }
  submission.updated_at = nowIso();
  await saveSubmission(store, submission);
  return response(event, 200, publicSubmission(submission));
}

async function handleDecision(event, store, submissionId) {
  const submission = await findSubmission(store, submissionId);
  if (!submission) {
    return response(event, 404, { error: "not_found" });
  }
  const input = parseBody(event);
  const decision = input.decision;
  if (!["approve", "needs_changes", "reject"].includes(decision)) {
    return response(event, 400, { error: "invalid_decision" });
  }
  if (decision === "approve") {
    submission.status = "approved";
  } else if (decision === "needs_changes") {
    submission.status = "needs_changes";
  } else {
    submission.status = "rejected";
  }
  if (input.record_id) {
    submission.record_id = input.record_id;
  }
  if (input.reviewed_payload) {
    submission.payload_json = contributorPayload(input.reviewed_payload);
  }
  if (Object.prototype.hasOwnProperty.call(input, "reviewed_by")) {
    submission.reviewed_by = input.reviewed_by || "";
  }
  if (Object.prototype.hasOwnProperty.call(input, "notes")) {
    submission.review_notes = input.notes || "";
  }
  submission.updated_at = nowIso();
  await saveSubmission(store, submission);
  return response(event, 200, publicSubmission(submission));
}

async function handleEvent(event) {
  if (event.httpMethod === "OPTIONS") {
    return response(event, 204);
  }

  if (!isAuthorized(event)) {
    return unauthorized(event);
  }

  const store = await getSubmissionStore();
  const submissionId = submissionIdFromPath(event);

  try {
    if (!submissionId && event.httpMethod === "GET") {
      return handleList(event, store);
    }
    if (!submissionId && event.httpMethod === "POST") {
      return handleCreate(event, store);
    }
    if (submissionId && isDecisionPath(event) && event.httpMethod === "POST") {
      return handleDecision(event, store, submissionId);
    }
    if (submissionId && event.httpMethod === "GET") {
      return handleGet(event, store, submissionId);
    }
    if (submissionId && event.httpMethod === "PATCH") {
      return handleUpdate(event, store, submissionId);
    }
    if (submissionId && event.httpMethod === "DELETE") {
      return handleDelete(event, store, submissionId);
    }
    return response(event, 405, { error: "method_not_allowed" });
  } catch (error) {
    return response(event, 500, { error: error instanceof Error ? error.message : "intake_api_error" });
  }
}

export default async function handler(request) {
  const event = await requestToEvent(request);
  return toWebResponse(await handleEvent(event));
}

export const config = {
  path: ["/submissions", "/submissions/*"],
};
