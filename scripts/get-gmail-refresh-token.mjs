import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, "..", ".env");

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const PORT = 4567;
const REDIRECT_URI = `http://localhost:${PORT}`;

function loadEnvFile(filePath) {
  const values = {};
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return values;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
  }
}

async function main() {
  const fileEnv = loadEnvFile(ENV_PATH);
  const clientId = process.env.GMAIL_CLIENT_ID || fileEnv.GMAIL_CLIENT_ID;
  const clientSecret =
    process.env.GMAIL_CLIENT_SECRET || fileEnv.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.\n" +
        `Add them to ${ENV_PATH} (or export them) and run this again.`,
    );
    process.exit(1);
  }

  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const state = base64Url(randomBytes(16));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const returnedCode = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      const reply = (message) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:system-ui;padding:3rem;text-align:center">
             <h2>${message}</h2>
             <p>You can close this tab and return to the terminal.</p>
           </body></html>`,
        );
      };

      if (error) {
        reply("Authorization failed");
        server.close();
        reject(new Error(`Google returned: ${error}`));
        return;
      }
      if (returnedState !== state) {
        reply("Authorization failed");
        server.close();
        reject(new Error("State mismatch — possible interference, aborting."));
        return;
      }
      if (!returnedCode) {
        reply("Authorization failed");
        server.close();
        reject(new Error("No authorization code returned."));
        return;
      }

      reply("Authorized ✓");
      server.close();
      resolve(returnedCode);
    });

    server.listen(PORT, () => {
      console.log("\nOpening the Google consent screen in your browser.");
      console.log("Sign in as the SENDING account (heroplab23@gmail.com).\n");
      console.log(`If the browser does not open, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });

    server.on("error", (err) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${PORT} is in use. Free it and retry.`)
          : err,
      );
    });
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok) {
    console.error("\nToken exchange failed:");
    console.error(JSON.stringify(tokens, null, 2));
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    console.error(
      "\nGoogle did not return a refresh token. This usually means the app " +
        "was already authorized for this account.\nRevoke it at " +
        "https://myaccount.google.com/permissions and run this again.",
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(64));
  console.log("Add this line to .env and to the Netlify environment:\n");
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\n" + "=".repeat(64));
  console.log("\nKeep this value secret. It grants send-as access to the account.");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
