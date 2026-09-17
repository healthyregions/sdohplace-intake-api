import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let cachedS3 = null;
let cachedLambda = null;

export const SPATIAL_LEVEL_MAP = {
  State: "state",
  County: "county",
  "Census Tract": "tract",
  "Census Block Group": "bg",
  "Zip Code Tabulation Area (ZCTA)": "zcta",
};

export const BOUNDARY_YEARS = ["2018", "2010"];

export const UPLOAD_KINDS = {
  csv: [".csv"],
  geo: [".zip", ".geojson", ".gpkg"],
};

const CONTENT_TYPES = {
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".geojson": "application/geo+json",
  ".gpkg": "application/geopackage+sqlite3",
};

export function uploadKindForFilename(filename) {
  const lowered = String(filename || "").toLowerCase();
  if (UPLOAD_KINDS.csv.some((extension) => lowered.endsWith(extension))) {
    return "csv";
  }
  if (UPLOAD_KINDS.geo.some((extension) => lowered.endsWith(extension))) {
    return "geo";
  }
  return null;
}

export function contentTypeForFilename(filename) {
  const lowered = String(filename || "").toLowerCase();
  const match = Object.keys(CONTENT_TYPES).find((extension) => lowered.endsWith(extension));
  return match ? CONTENT_TYPES[match] : "application/octet-stream";
}

export const UPLOAD_URL_TTL_SECONDS = 3600;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const LARGE_UPLOAD_BYTES = 100 * 1024 * 1024;
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${Math.round(value / (1024 * 1024))} MB`;
  }
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export class SpatialPipelineError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "SpatialPipelineError";
    this.status = status;
  }
}

function env(name, fallback = "") {
  const value = typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  return value === undefined || value === "" ? fallback : value;
}

function awsCredentials() {
  const accessKeyId = env("SPATIAL_AWS_ACCESS_KEY_ID") || env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("SPATIAL_AWS_SECRET_ACCESS_KEY") || env("AWS_SECRET_ACCESS_KEY");
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

export function spatialConfig() {
  return {
    bucket: env("SPATIAL_UPLOAD_BUCKET", "herop-sdohplace-upload"),
    lambdaName: env("SPATIAL_LAMBDA_NAME", "herop-sdohplace-spatial"),
    region: env("SPATIAL_AWS_REGION") || env("AWS_REGION", "us-east-2"),
    isConfigured: Boolean(awsCredentials()),
  };
}

function clientOptions() {
  const { region } = spatialConfig();
  const credentials = awsCredentials();
  return credentials ? { region, credentials } : { region };
}

function s3Client() {
  if (!cachedS3) {
    cachedS3 = new S3Client(clientOptions());
  }
  return cachedS3;
}

function lambdaClient() {
  if (!cachedLambda) {
    cachedLambda = new LambdaClient(clientOptions());
  }
  return cachedLambda;
}

export function sanitizeFilename(filename) {
  const base = String(filename || "").split(/[\\/]/).pop() || "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 200);
}

export function isAllowedUpload(filename, uploadKind = "csv") {
  const extensions = UPLOAD_KINDS[uploadKind];
  if (!extensions) {
    return false;
  }
  const lowered = String(filename || "").toLowerCase();
  return extensions.some((extension) => lowered.endsWith(extension));
}

function timestampSegment() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function newJobKey(ownerId, filename, { contributor = false } = {}) {
  const prefix = contributor ? `uploads/contrib/${ownerId}` : `uploads/${ownerId}`;
  return `${prefix}/${timestampSegment()}/${filename}`;
}

export function resultKey(s3Key) {
  const index = String(s3Key).lastIndexOf("/");
  return index === -1 ? "result.json" : `${s3Key.slice(0, index)}/result.json`;
}

export function isOwnedKey(s3Key, ownerId, { contributor = false } = {}) {
  const prefix = contributor ? `uploads/contrib/${ownerId}/` : `uploads/${ownerId}/`;
  return typeof s3Key === "string" && s3Key.startsWith(prefix) && !s3Key.includes("..");
}

export function validateJobInput({ boundaryYear, spatialLevel, uploadKind = "csv" }) {
  const errors = [];
  if (!Object.prototype.hasOwnProperty.call(UPLOAD_KINDS, uploadKind)) {
    errors.push("Upload a CSV, a zipped shapefile, GeoJSON, or a GeoPackage.");
    return errors;
  }
  if (uploadKind === "csv") {
    if (!BOUNDARY_YEARS.includes(String(boundaryYear))) {
      errors.push("Choose a boundary year (2018 or 2010).");
    }
    if (!Object.prototype.hasOwnProperty.call(SPATIAL_LEVEL_MAP, spatialLevel)) {
      errors.push("Choose a spatial level for the CSV join.");
    }
  }
  return errors;
}

export function buildPayload({
  recordId,
  s3Key,
  uploadKind = "csv",
  boundaryYear,
  spatialLevel,
  geoIdColumn,
}) {
  const payload = {
    record_id: recordId,
    s3_key: s3Key,
    upload_kind: uploadKind,
  };
  if (uploadKind === "csv") {
    payload.boundary_year = Number(boundaryYear);
    payload.spatial_level = SPATIAL_LEVEL_MAP[spatialLevel] || spatialLevel;
    if (geoIdColumn) {
      payload.geo_id_column = geoIdColumn;
    }
  }
  return payload;
}

export async function createUploadUrl(s3Key, contentType = "text/csv") {
  const { bucket } = spatialConfig();
  try {
    return await getSignedUrl(
      s3Client(),
      new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  } catch (error) {
    throw new SpatialPipelineError(`Could not create an upload URL: ${error.message}`);
  }
}

export async function invokePipeline(payload) {
  const { lambdaName } = spatialConfig();
  let response;
  try {
    response = await lambdaClient().send(
      new InvokeCommand({
        FunctionName: lambdaName,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  } catch (error) {
    throw new SpatialPipelineError(`Lambda invoke failed: ${error.message}`);
  }
  if (response.StatusCode !== 202) {
    throw new SpatialPipelineError(`Lambda invoke returned status ${response.StatusCode}`);
  }
}

export async function fetchResult(key) {
  const { bucket } = spatialConfig();
  let response;
  try {
    response = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const code = error?.name || error?.Code || "";
    if (code === "NoSuchKey" || code === "NotFound" || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw new SpatialPipelineError(`Could not read result.json: ${error.message}`);
  }
  const body = await response.Body.transformToString();
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new SpatialPipelineError(`result.json is not valid JSON: ${error.message}`);
  }
}

export function normalizeResult(result) {
  if (!result) {
    return { status: "pending" };
  }
  if (!result.ok) {
    return {
      status: "failed",
      error_code: result.error_code || "unknown",
      message: result.message || "",
    };
  }
  return {
    status: "ready",
    result: {
      geometry: result.geometry || "",
      bounding_box: result.bounding_box || "",
      centroid: result.centroid || "",
      spatial_coverage: result.spatial_coverage || [],
      highlight_ids: result.highlight_ids || [],
      diagnostics: result.diagnostics || {},
    },
  };
}
