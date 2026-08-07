/**
 * Admin-only endpoint for verifying email delivery without creating fake
 * submissions.
 *
 *   POST /email/test
 *   Authorization: Bearer <INTAKE_API_TOKEN>
 *   { "to": "test@example.org", "template": "submission_received" }
 */

import { mailerConfig, sendMail } from "./lib/gmail.mjs";
import { renderTemplate, submissionUrl, templateNames } from "./lib/templates.mjs";

const API_TOKEN = process.env.INTAKE_API_TOKEN || "";

function corsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function response(statusCode, body = {}) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: statusCode === 204 ? "" : JSON.stringify(body, null, 2),
  };
}

function isAuthorized(event) {
  if (!API_TOKEN) {
    return false;
  }
  const header =
    event.headers?.authorization || event.headers?.Authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && match[1] === API_TOKEN);
}

/** Representative values so every template renders with realistic content. */
function sampleContext() {
  const title = "Example dataset: Chicago Food Access 2024";
  const url = submissionUrl("test-0001");
  return {
    title,
    url,
    notes: "This is a sample reviewer note used for delivery testing.",
    submitterName: "Test Contributor",
    submitterEmail: "test-contributor@example.org",
    count: 2,
    lines: `- ${title} (submitted 5 days ago)\n- Another pending dataset (submitted 9 days ago)`,
    event: "submission_received",
    recipient: "test-contributor@example.org",
    errorMessage: "sample error text",
    submissionId: "test-0001",
  };
}

export const handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return response(204);
  }
  if (!isAuthorized(event)) {
    return response(401, { error: "unauthorized" });
  }
  if (event.httpMethod !== "POST") {
    return response(405, { error: "method_not_allowed" });
  }

  let input = {};
  try {
    input = event.body ? JSON.parse(event.body) : {};
  } catch {
    return response(400, { error: "invalid_json" });
  }

  const config = mailerConfig();
  const templates = templateNames();

  if (!input.template) {
    return response(200, {
      message: "Specify a template to send.",
      templates,
      config: {
        enabled: config.enabled,
        dryRun: config.dryRun,
        isConfigured: config.isConfigured,
        sender: config.sender || "(unset)",
      },
    });
  }
  if (!templates.includes(input.template)) {
    return response(400, { error: "unknown_template", templates });
  }
  if (!input.to) {
    return response(400, { error: "missing_to" });
  }

  let rendered;
  try {
    rendered = renderTemplate(input.template, sampleContext());
  } catch (error) {
    return response(500, {
      error: error instanceof Error ? error.message : "render_failed",
    });
  }

  const result = await sendMail({
    to: input.to,
    subject: rendered.subject,
    body: rendered.body,
  });

  return response(200, {
    template: input.template,
    subject: rendered.subject,
    body: rendered.body,
    result,
    config: {
      enabled: config.enabled,
      dryRun: config.dryRun,
      isConfigured: config.isConfigured,
    },
  });
};
