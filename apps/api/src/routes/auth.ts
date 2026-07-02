import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Router } from "express";

import "../config/load-env.js";

export const authRouter: Router = Router();

interface AuthUser {
  id: string;
  name: string;
  login: string;
  email?: string;
  avatarUrl: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface JwtPayload {
  user: AuthUser;
  exp: number;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "" || value === "change-me") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(user: AuthUser): string {
  const secret = readRequiredEnv("JWT_SECRET");
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      user,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");

  return `${header}.${payload}.${signature}`;
}

function verifyJwt(token: string): JwtPayload {
  const secret = readRequiredEnv("JWT_SECRET");
  const [header, payload, signature] = token.split(".");

  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error("Invalid token");
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(signature);

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error("Invalid token");
  }

  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Invalid token");
  }

  const jwtPayload = decoded as JwtPayload;

  if (typeof jwtPayload.exp !== "number" || jwtPayload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired token");
  }

  return jwtPayload;
}

async function exchangeCodeForAccessToken(code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: readRequiredEnv("GITHUB_OAUTH_CLIENT_ID"),
      client_secret: readRequiredEnv("GITHUB_OAUTH_CLIENT_SECRET"),
      code,
    }),
  });
  const tokenResponse = (await response.json()) as GitHubTokenResponse;

  if (!response.ok || tokenResponse.access_token === undefined) {
    throw new Error(
      tokenResponse.error_description ?? tokenResponse.error ?? "GitHub OAuth failed",
    );
  }

  return tokenResponse.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<AuthUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "opticpr",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch GitHub user");
  }

  const user = (await response.json()) as GitHubUserResponse;

  return {
    id: String(user.id),
    name: user.name ?? user.login,
    login: user.login,
    ...(user.email === null ? {} : { email: user.email }),
    avatarUrl: user.avatar_url,
  };
}

authRouter.get("/github", (_request, response, next) => {
  try {
    const clientId = readRequiredEnv("GITHUB_OAUTH_CLIENT_ID");
    const appWebUrl = process.env.APP_WEB_URL ?? "http://localhost:5173";
    const state = randomBytes(24).toString("base64url");
    const redirectUri = new URL("/auth/callback", appWebUrl).toString();
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");

    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", "read:user user:email");
    authorizationUrl.searchParams.set("state", state);

    response.redirect(authorizationUrl.toString());
  } catch (error) {
    next(error);
  }
});

authRouter.post("/github/callback", async (request, response, next) => {
  try {
    const body: unknown = request.body;
    const code =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).code
        : undefined;

    if (typeof code !== "string" || code.trim() === "") {
      response.status(400).json({ error: "Missing GitHub OAuth code" });
      return;
    }

    const accessToken = await exchangeCodeForAccessToken(code);
    const user = await fetchGitHubUser(accessToken);
    const token = signJwt(user);

    response.json({ token, user });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", (request, response) => {
  const authorization = request.header("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = verifyJwt(authorization.slice("Bearer ".length));

    response.json(payload.user);
  } catch {
    response.status(401).json({ error: "Unauthorized" });
  }
});
