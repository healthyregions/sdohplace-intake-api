function env(name, fallback = "") {
	const value =
		typeof process !== "undefined" && process.env
			? process.env[name]
			: undefined;
	return value === undefined || value === "" ? fallback : value;
}

function discoveryBaseUrl() {
	return env("DISCOVERY_APP_URL", "https://search.sdohplace.org").replace(
		/\/$/,
		"",
	);
}

function allowedOrigins() {
	const configured = env("ALLOWED_SITE_ORIGINS", "")
		.split(",")
		.map((entry) => entry.trim().replace(/\/$/, ""))
		.filter(Boolean);
	return [discoveryBaseUrl(), ...configured];
}

function isAllowedOrigin(origin) {
	const candidate = String(origin || "").replace(/\/$/, "");
	if (!candidate) {
		return false;
	}
	return allowedOrigins().some((allowed) => {
		const starIndex = allowed.indexOf("://*");
		if (starIndex !== -1) {
			const scheme = allowed.slice(0, starIndex);
			const suffix = allowed.slice(starIndex + 4);
			if (!candidate.startsWith(`${scheme}://`) || !candidate.endsWith(suffix)) {
				return false;
			}
			const host = candidate.slice(`${scheme}://`.length, candidate.length - suffix.length);
			return host.length > 0 && !host.includes("/");
		}
		return candidate === allowed;
	});
}

export function siteBaseUrl(siteOrigin) {
	if (siteOrigin && isAllowedOrigin(siteOrigin)) {
		return String(siteOrigin).replace(/\/$/, "");
	}
	return discoveryBaseUrl();
}

export function submissionUrl(submissionId, siteOrigin) {
	if (!submissionId) {
		return "";
	}
	return `${siteBaseUrl(siteOrigin)}/contribute/submissions/?id=${encodeURIComponent(
		String(submissionId),
	)}`;
}

export function reviewUrl(submissionId) {
	const base = env("MANAGER_PUBLIC_URL", "").replace(/\/$/, "");
	if (!base || !submissionId) {
		return "";
	}
	return `${base}/submissions/${encodeURIComponent(String(submissionId))}`;
}

export function submissionTitle(submission) {
	const payload = (submission && submission.payload_json) || {};
	const candidate =
		payload.title ||
		payload.dct_title_s ||
		payload.name ||
		(submission && submission.title);
	const text = String(candidate || "").trim();
	return text || `Submission ${submission?.id ?? ""}`.trim();
}

function contactLine() {
	const contact = env("CONTACT_EMAIL", "");
	return contact
		? `\nIf you have any question, please feel free to reach out to us at ${contact}.\n`
		: "";
}

function section(label, value) {
	return value ? `${label}\n${value}\n\n` : "";
}

function splitSubject(text) {
	const trimmed = text.trim();
	const lines = trimmed.split("\n");
	if (lines[0].startsWith("Subject:")) {
		return {
			subject: lines[0].replace("Subject:", "").trim(),
			body: lines.slice(1).join("\n").replace(/^\n+/, ""),
		};
	}
	return { subject: "", body: trimmed };
}

const templates = {
	submission_received: ({
		title,
		url,
	}) => `Subject: SDOH & Place submission received: ${title}

Hello,

Thank you for submitting to the SDOH & Place data discovery platform. We have received your submission and our team will review it soon.

${section("You can view your submission here:", url)}Submission: ${title}
${contactLine()}
Thank you,
SDOH & Place Team`,

	submission_approved: ({
		title,
		url,
		notes,
	}) => `Subject: SDOH & Place submission approved: ${title}

Hello,

Thank you for submitting to the SDOH & Place data discovery platform. Your submission has been approved.

${section("Reviewer comments:", notes)}${section("You can review the submitted record here:", url)}Submission: ${title}
${contactLine()}
Thank you,
SDOH & Place Team`,

	submission_needs_changes: ({
		title,
		url,
		notes,
	}) => `Subject: SDOH & Place submission needs changes: ${title}

Hello,

Thank you for submitting to SDOH & Place data discovery platform. Your submission needs some changes.

${section("Please refer to our comments:", notes)}${section("You can review and resubmit your submission here:", url)}Submission: ${title}
${contactLine()}
Thank you,
SDOH & Place Team`,

	submission_rejected: ({
		title,
		url,
		notes,
	}) => `Subject: SDOH & Place submission update: ${title}

Hello,

Thank you for submitting to the SDOH & Place data discovery platform. After review, we are unable to accept this submission at this time.

${section("Reviewer comments:", notes)}${section("You can review your submission here:", url)}Submission: ${title}
${contactLine()}
Thank you,
SDOH & Place Team`,

	submission_published: ({
		title,
		url,
	}) => `Subject: SDOH & Place submission is now live: ${title}

Hello,

Your submission is now published and searchable on the SDOH & Place data discovery platform.

${section("View it here:", url)}Submission: ${title}
${contactLine()}
Thank you,
SDOH & Place Team`,

	reviewer_new_submission: ({ title, url, submitterName, submitterEmail }) =>
		`Subject: [SDOH & Place] New submission awaiting review: ${title}

A new submission has been received.

Submission: ${title}
Submitted by: ${submitterName || "Unknown"}${submitterEmail ? ` <${submitterEmail}>` : ""}

${section("Review it here:", url)}This is an automated notification from the SDOH & Place intake API.`,

	reviewer_resubmission: ({ title, url, submitterName, submitterEmail }) =>
		`Subject: [SDOH & Place] Submission resubmitted after changes: ${title}

A contributor has updated and resubmitted a submission that was marked as needing changes.

Submission: ${title}
Submitted by: ${submitterName || "Unknown"}${submitterEmail ? ` <${submitterEmail}>` : ""}

${section("Review it here:", url)}This is an automated notification from the SDOH & Place intake API.`,

	reviewer_digest: ({ count, lines }) =>
		`Subject: [SDOH & Place] ${count} submission${count === 1 ? "" : "s"} pending review

The following submission${count === 1 ? " has" : "s have"} been waiting for review:

${lines}

This is an automated weekly summary from the SDOH & Place intake API.`,

	admin_send_failure: ({ event, recipient, errorMessage, submissionId }) =>
		`Subject: [SDOH & Place] Email delivery failed (${event})

An outgoing notification could not be delivered.

Event: ${event}
Intended recipient: ${recipient || "(none)"}
Submission: ${submissionId || "(n/a)"}
Error: ${errorMessage}

The submission itself was saved successfully. You may need to contact the
contributor manually.`,
};

export function renderTemplate(name, context = {}) {
	const template = templates[name];
	if (!template) {
		throw new Error(`Unknown email template: ${name}`);
	}
	return splitSubject(template(context));
}

export function templateNames() {
	return Object.keys(templates);
}

export function decisionTemplateName(status) {
	if (status === "approved") return "submission_approved";
	if (status === "needs_changes") return "submission_needs_changes";
	if (status === "rejected") return "submission_rejected";
	return "";
}
