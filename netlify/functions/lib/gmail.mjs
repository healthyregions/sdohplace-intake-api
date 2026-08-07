const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

let cachedToken = null;

function env(name, fallback = "") {
  const value =
    typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  return value === undefined || value === "" ? fallback : value;
}

function isTruthy(value) {
  return String(value).toLowerCase() === "true";
}

export function mailerConfig() {
  const clientId = env("GMAIL_CLIENT_ID");
  const clientSecret = env("GMAIL_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");
  const sender = env("GMAIL_SENDER");
  return {
    clientId,
    clientSecret,
    refreshToken,
    sender,
    fromName: env("EMAIL_FROM_NAME", "SDOH & Place"),
    enabled: isTruthy(env("EMAIL_ENABLED", "false")),
    dryRun: isTruthy(env("EMAIL_DRY_RUN", "false")),
    isConfigured: Boolean(clientId && clientSecret && refreshToken && sender),
  };
}

async function getAccessToken(config) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    cachedToken = null;
    const detail = data.error_description || data.error || response.status;
    throw new Error(`Gmail token refresh failed: ${detail}`);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: now + Math.max((data.expires_in || 3600) - 60, 60) * 1000,
  };
  return cachedToken.value;
}

function encodeHeader(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7E]*$/.test(text)) {
    return text;
  }
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

function base64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toRecipientList(to) {
  const list = Array.isArray(to) ? to : String(to || "").split(",");
  return list.map((entry) => entry.trim()).filter(Boolean);
}

function buildMessage({ from, fromName, to, subject, body, replyTo }) {
  const safeSubject = String(subject || "").replace(/[\r\n]+/g, " ").trim();
  const headers = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(safeSubject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (replyTo) {
    headers.push(`Reply-To: ${replyTo}`);
  }
  return `${headers.join("\r\n")}\r\n\r\n${String(body || "").replace(/\r?\n/g, "\r\n")}`;
}


export async function sendMail({ to, subject, body, replyTo }) {
  const config = mailerConfig();
  const recipients = toRecipientList(to);

  if (recipients.length === 0) {
    return { sent: false, skipped: "no_recipient" };
  }
  if (!config.enabled) {
    return { sent: false, skipped: "email_disabled" };
  }
  if (!config.isConfigured) {
    return { sent: false, skipped: "email_not_configured" };
  }
  if (config.dryRun) {
    console.log(
      `[email:dry-run] to=${recipients.join(",")} subject=${subject}\n${body}`,
    );
    return { sent: false, skipped: "dry_run", to: recipients, subject };
  }

  try {
    const accessToken = await getAccessToken(config);
    const raw = base64Url(
      buildMessage({
        from: config.sender,
        fromName: config.fromName,
        to: recipients,
        subject,
        body,
        replyTo: replyTo || env("CONTACT_EMAIL", ""),
      }),
    );
    const response = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        (data.error && (data.error.message || data.error.status)) ||
        `HTTP ${response.status}`;
      throw new Error(detail);
    }
    console.log(
      `[email:sent] to=${recipients.join(",")} subject=${subject} id=${data.id || ""}`,
    );
    return { sent: true, id: data.id, to: recipients, subject };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[email:failed] to=${recipients.join(",")} subject=${subject} error=${message}`,
    );
    return { sent: false, error: message, to: recipients, subject };
  }
}
