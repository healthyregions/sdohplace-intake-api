import {
  SPATIAL_LEVEL_MAP,
  BOUNDARY_YEARS,
  UPLOAD_KINDS,
  MAX_UPLOAD_BYTES,
  LARGE_UPLOAD_BYTES,
  SpatialPipelineError,
  buildPayload,
  contentTypeForFilename,
  formatBytes,
  createUploadUrl,
  fetchResult,
  invokePipeline,
  isOwnedKey,
  newJobKey,
  normalizeResult,
  resultKey,
  sanitizeFilename,
  spatialConfig,
  uploadKindForFilename,
  validateJobInput,
} from "./lib/spatial.mjs";

const API_TOKEN = process.env.INTAKE_API_TOKEN || "";
const DEFAULT_CORS_ORIGINS =
  "http://localhost:3000,http://localhost:3001,http://localhost:5000,http://localhost:8888";

function corsOrigins() {
  return (process.env.INTAKE_API_CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const origins = corsOrigins();
  const allowOrigin =
    origin && (origins.includes(origin) || origins.includes("*"))
      ? origin
      : origins.includes("*")
        ? "*"
        : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function isAuthorized(event) {
  if (!API_TOKEN) {
    return true;
  }
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  return header === `Bearer ${API_TOKEN}`;
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function actionFromPath(event) {
  const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || "";
  const match = path.match(/\/spatial\/?(.*)$/);
  const rest = match ? match[1] : "";
  return rest.split("/").filter(Boolean).map(decodeURIComponent)[0] || "";
}

function jobOwner(input) {
  const contributor = Boolean(input.submission_id);
  const ownerId = String(contributor ? input.submission_id : input.record_id || "").trim();
  return { contributor, ownerId };
}

function isValidOwnerId(ownerId) {
  return Boolean(ownerId) && /^[A-Za-z0-9._-]+$/.test(ownerId) && !ownerId.includes("..");
}

async function handleUploadUrl(event) {
  const input = parseBody(event);
  const { contributor, ownerId } = jobOwner(input);
  if (!isValidOwnerId(ownerId)) {
    return response(event, 400, { error: "invalid_owner_id" });
  }

  const filename = sanitizeFilename(input.filename);
  if (!filename) {
    return response(event, 400, { error: "invalid_filename" });
  }
  const uploadKind = uploadKindForFilename(filename);
  if (!uploadKind) {
    return response(event, 400, {
      error: "unsupported_file_type",
      message: "Upload a .csv, a zipped shapefile, .geojson, or .gpkg file.",
    });
  }

  const fileSize = Number(input.file_size) || 0;
  if (fileSize > MAX_UPLOAD_BYTES) {
    return response(event, 413, {
      error: "file_too_large",
      message:
        `That file is ${formatBytes(fileSize)}. The limit is ` +
        `${formatBytes(MAX_UPLOAD_BYTES)}. Try removing columns or features you do not ` +
        `need, or get in touch and we can load it for you.`,
      max_bytes: MAX_UPLOAD_BYTES,
    });
  }
  const contentType = contentTypeForFilename(filename);
  const s3Key = newJobKey(ownerId, filename, { contributor });
  const uploadUrl = await createUploadUrl(s3Key, contentType);
  return response(event, 200, {
    upload_url: uploadUrl,
    s3_key: s3Key,
    content_type: contentType,
    upload_kind: uploadKind,
  });
}

async function handleStart(event) {
  const input = parseBody(event);
  const { contributor, ownerId } = jobOwner(input);
  if (!isValidOwnerId(ownerId)) {
    return response(event, 400, { error: "invalid_owner_id" });
  }

  const s3Key = String(input.s3_key || "");
  if (!isOwnedKey(s3Key, ownerId, { contributor })) {
    return response(event, 400, { error: "invalid_s3_key" });
  }

  const uploadKind = input.upload_kind || uploadKindForFilename(s3Key);
  const errors = validateJobInput({
    boundaryYear: input.boundary_year,
    spatialLevel: input.spatial_level,
    uploadKind,
  });
  if (errors.length > 0) {
    return response(event, 400, { error: "invalid_request", messages: errors });
  }

  await invokePipeline(
    buildPayload({
      recordId: ownerId,
      s3Key,
      uploadKind,
      boundaryYear: input.boundary_year,
      spatialLevel: input.spatial_level,
      geoIdColumn: String(input.geo_id_column || "").trim(),
    }),
  );

  return response(event, 202, { status: "pending", s3_key: s3Key, upload_kind: uploadKind });
}

async function handleStatus(event) {
  const params = event.queryStringParameters || {};
  const s3Key = String(params.key || "");
  const contributor = Boolean(params.submission_id);
  const ownerId = String(contributor ? params.submission_id : params.record_id || "").trim();
  if (!isValidOwnerId(ownerId)) {
    return response(event, 400, { error: "invalid_owner_id" });
  }
  if (!isOwnedKey(s3Key, ownerId, { contributor })) {
    return response(event, 400, { error: "invalid_s3_key" });
  }

  const result = await fetchResult(resultKey(s3Key));
  return response(event, 200, { s3_key: s3Key, ...normalizeResult(result) });
}

function handleOptionsList(event) {
  const extensions = Object.values(UPLOAD_KINDS).flat();
  return response(event, 200, {
    spatial_levels: Object.keys(SPATIAL_LEVEL_MAP),
    boundary_years: BOUNDARY_YEARS,
    upload_kinds: Object.keys(UPLOAD_KINDS),
    upload_extensions: UPLOAD_KINDS,
    accept: extensions.join(","),
    max_upload_bytes: MAX_UPLOAD_BYTES,
    large_upload_bytes: LARGE_UPLOAD_BYTES,
  });
}

export const handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return response(event, 204);
  }
  if (!isAuthorized(event)) {
    return response(event, 401, { error: "unauthorized" });
  }
  const { isConfigured } = spatialConfig();
  if (!isConfigured) {
    return response(event, 503, {
      error: "spatial_not_configured",
      message: "AWS credentials are not configured for the intake API.",
    });
  }
  const action = actionFromPath(event);
  try {
    if (action === "options" && event.httpMethod === "GET") {
      return handleOptionsList(event);
    }
    if (action === "upload-url" && event.httpMethod === "POST") {
      return handleUploadUrl(event);
    }
    if (action === "start" && event.httpMethod === "POST") {
      return handleStart(event);
    }
    if (action === "status" && event.httpMethod === "GET") {
      return handleStatus(event);
    }
    return response(event, 405, { error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof SpatialPipelineError) {
      return response(event, error.status, { error: "spatial_pipeline_error", message: error.message });
    }
    return response(event, 500, {
      error: error instanceof Error ? error.message : "spatial_api_error",
    });
  }
};
