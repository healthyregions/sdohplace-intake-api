import { sendMail } from "./gmail.mjs";
import {
  decisionTemplateName,
  renderTemplate,
  reviewUrl,
  submissionTitle,
  submissionUrl,
} from "./templates.mjs";

function env(name, fallback = "") {
  const value =
    typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  return value === undefined || value === "" ? fallback : value;
}

function reviewerRecipients() {
  return env("REVIEWER_EMAILS", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function adminRecipients() {
  const configured = env("ADMIN_ALERT_EMAILS", "");
  const list = (configured || env("REVIEWER_EMAILS", ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list;
}

async function alertAdmin(event, result, submissionId) {
  const recipients = adminRecipients();
  if (recipients.length === 0) {
    return;
  }
  try {
    const { subject, body } = renderTemplate("admin_send_failure", {
      event,
      recipient: (result.to || []).join(", "),
      errorMessage: result.error || "unknown error",
      submissionId,
    });
    await sendMail({ to: recipients, subject, body });
  } catch (error) {
    console.error(
      `[email:alert-failed] ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function deliver(event, to, templateName, context, submissionId, indexEnv) {
  try {
    const rendered = renderTemplate(templateName, context);
    const body = rendered.body;
    const subject =
      indexEnv === "dev" ? `[DEV ONLY] ${rendered.subject}` : rendered.subject;
    const result = await sendMail({ to, subject, body });
    if (!result.sent && result.error) {
      await alertAdmin(event, result, submissionId);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[email:${event}] ${message}`);
    return { sent: false, error: message };
  }
}

function submitterEmail(submission) {
  return String((submission && submission.submitter_email) || "").trim();
}

export async function notifySubmissionCreated(submission) {
  const title = submissionTitle(submission);
  const id = submission?.id;
  const context = {
    title,
    url: submissionUrl(id, submission?.site_origin),
    submitterName: submission?.submitter_name,
    submitterEmail: submitterEmail(submission),
  };
  await Promise.all([
    deliver(
      "submission_received",
      submitterEmail(submission),
      "submission_received",
      context,
      id,
    ),
    deliver(
      "reviewer_new_submission",
      reviewerRecipients(),
      "reviewer_new_submission",
      {
        ...context,
        url: reviewUrl(id) || submissionUrl(id, submission?.site_origin),
      },
      id,
    ),
  ]);
}

export async function notifyDecision(submission, notes) {
  const templateName = decisionTemplateName(submission?.status);
  if (!templateName) {
    return;
  }
  const id = submission?.id;
  await deliver(
    templateName,
    submitterEmail(submission),
    templateName,
    {
      title: submissionTitle(submission),
      url: submissionUrl(id, submission?.site_origin),
      notes: notes || submission?.review_notes || "",
    },
    id,
  );
}

export async function notifyResubmission(submission) {
  const id = submission?.id;
  await deliver(
    "reviewer_resubmission",
    reviewerRecipients(),
    "reviewer_resubmission",
    {
      title: submissionTitle(submission),
      url: reviewUrl(id) || submissionUrl(id, submission?.site_origin),
      submitterName: submission?.submitter_name,
      submitterEmail: submitterEmail(submission),
    },
    id,
  );
}

export async function notifyPublished(submission, indexEnv) {
  const id = submission?.id;
  await deliver(
    "submission_published",
    submitterEmail(submission),
    "submission_published",
    {
      title: submissionTitle(submission),
      url: submissionUrl(id, submission?.site_origin),
    },
    id,
    indexEnv,
  );
}

export async function notifySubmissionDeleted(submission, actor, reviewer) {
  const id = submission?.id;
  const title = submissionTitle(submission);
  const previousStatus = submission?.status || "";
  if (actor === "admin") {
    await Promise.all([
      deliver(
        "submission_deleted",
        submitterEmail(submission),
        "submission_deleted",
        { title },
        id,
      ),
      deliver(
        "reviewer_submission_deleted",
        reviewerRecipients(),
        "reviewer_submission_deleted",
        {
          title,
          previousStatus,
          reviewer,
          submitterName: submission?.submitter_name,
          submitterEmail: submitterEmail(submission),
        },
        id,
      ),
    ]);
    return;
  }
  await deliver(
    "reviewer_submission_withdrawn",
    reviewerRecipients(),
    "reviewer_submission_withdrawn",
    {
      title,
      previousStatus,
      submitterName: submission?.submitter_name,
      submitterEmail: submitterEmail(submission),
    },
    id,
  );
}

export async function notifyRecordDeleted(submission, indexEnv) {
  const id = submission?.id;
  await deliver(
    "record_deleted",
    submitterEmail(submission),
    "record_deleted",
    { title: submissionTitle(submission) },
    id,
    indexEnv,
  );
}
