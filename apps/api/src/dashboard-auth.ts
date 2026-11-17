import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, Response } from 'express';
import type { PrismaClient } from '@opticpr/database';

export class DashboardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AccessibleRepository {
  id: string;
  installationId: string;
  owner: string;
  name: string;
  maintainer: boolean;
  canPublish: boolean;
}
export interface DashboardGitHub {
  exchange(code: string): Promise<{ token: string; expiresIn: number }>;
  identity(token: string): Promise<{ id: string; login: string }>;
  repositories(token: string): Promise<AccessibleRepository[]>;
}
export interface DashboardConfig {
  origin: string;
  secret: string;
  clientId: string;
  clientSecret: string;
  appSlug?: string;
}
export function dashboardConfigFromEnv(): DashboardConfig | undefined {
  const {
    DASHBOARD_ORIGIN: origin,
    SESSION_SECRET: secret,
    GITHUB_CLIENT_ID: clientId,
    GITHUB_CLIENT_SECRET: clientSecret,
  } = process.env;
  return origin && secret && clientId && clientSecret
    ? {
        origin,
        secret,
        clientId,
        clientSecret,
        appSlug: process.env.GITHUB_APP_SLUG,
      }
    : undefined;
}
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function constantEqual(a: string, b: string): boolean {
  return (
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function sessionManager(db: PrismaClient, config: DashboardConfig) {
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error(
      'DASHBOARD_ORIGIN must be an HTTPS origin (HTTP loopback allowed locally)',
    );
  if (Buffer.byteLength(config.secret) < 32)
    throw new Error('SESSION_SECRET must contain at least 32 bytes');
  const secure = origin.protocol === 'https:';
  const sessionCookie = secure ? '__Host-opticpr' : 'opticpr_session';
  const stateCookie = secure ? '__Host-opticpr_state' : 'opticpr_state';
  const key = createHash('sha256').update(config.secret).digest();
  function seal(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
  }
  function unseal(value: string) {
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      cipher.update(bytes.subarray(12, -16)),
      cipher.final(),
    ]).toString('utf8');
  }
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
  };
  return {
    async create(
      res: Response,
      user: { id: string; login: string },
      token: string,
      expiresIn: number,
    ) {
      const id = randomBytes(32).toString('base64url');
      const maxAge = Math.min(expiresIn, 8 * 60 * 60) * 1000;
      await db.dashboardSession.create({
        data: {
          id: sha256(id),
          userId: user.id,
          login: user.login,
          credential: seal(token),
          csrfToken: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + maxAge),
        },
      });
      const old = cookie(
        { headers: { cookie: res.req.headers.cookie } } as Request,
        sessionCookie,
      );
      if (old)
        await db.dashboardSession.deleteMany({ where: { id: sha256(old) } });
      res.cookie(sessionCookie, id, { ...cookieOptions, maxAge });
      // Bound retained expired credentials without a separate cleanup service.
      await db.dashboardSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      return id;
    },
    async require(req: Request) {
      const id = cookie(req, sessionCookie);
      const session = id
        ? await db.dashboardSession.findUnique({ where: { id: sha256(id) } })
        : null;
      if (!session || session.expiresAt <= new Date())
        throw new DashboardError(401, 'Sign in to continue');
      return { ...session, token: unseal(session.credential) };
    },
    csrf(req: Request, session: { csrfToken: string }) {
      if (
        req.get('origin') !== config.origin ||
        !constantEqual(req.get('x-csrf-token') ?? '', session.csrfToken)
      )
        throw new DashboardError(403, 'CSRF validation failed');
    },
    async logout(req: Request, res: Response) {
      const session = await this.require(req);
      this.csrf(req, session);
      await db.dashboardSession.delete({ where: { id: session.id } });
      res.clearCookie(sessionCookie, cookieOptions);
    },
    begin(req: Request, res: Response) {
      const requested =
        typeof req.query.returnTo === 'string' ? req.query.returnTo : '/repos';
      const destination =
        /^\/(?:repos(?:\/[A-Za-z0-9_-]+)?|runs\/[0-9a-f-]+)(?:\?[A-Za-z0-9_=&%-]*)?$/.test(
          requested,
        ) && requested.length < 600
          ? requested
          : '/repos';
      const value = `${randomBytes(32).toString('base64url')}.${Date.now()}.${Buffer.from(destination).toString('base64url')}`;
      const state = `${value}.${createHmac('sha256', key).update(value).digest('base64url')}`;
      res.cookie(stateCookie, state, {
        ...cookieOptions,
        maxAge: 10 * 60 * 1000,
      });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.origin}/auth/github/callback`,
        state,
      }).toString();
      res.redirect(url.href);
    },
    verifyState(req: Request, res: Response) {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const saved = cookie(req, stateCookie) ?? '';
      res.clearCookie(stateCookie, cookieOptions);
      const [nonce, timestamp, destination, signature] = state.split('.');
      if (
        !nonce ||
        !timestamp ||
        !destination ||
        !signature ||
        !constantEqual(state, saved) ||
        !constantEqual(
          signature,
          createHmac('sha256', key)
            .update(`${nonce}.${timestamp}.${destination}`)
            .digest('base64url'),
        ) ||
        !Number.isFinite(Number(timestamp)) ||
        Date.now() - Number(timestamp) > 600000 ||
        Number(timestamp) > Date.now()
      )
        throw new DashboardError(400, 'OAuth state is invalid or expired');
      return Buffer.from(destination, 'base64url').toString('utf8');
    },
  };
}

export function githubDashboardClient(
  config: DashboardConfig,
  fetcher = globalThis.fetch,
): DashboardGitHub {
  async function request(path: string, token: string) {
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401)
      throw new DashboardError(
        401,
        'GitHub authorization expired; sign in again',
      );
    if (
      [403, 404].includes(response.status) &&
      !response.headers.get('retry-after') &&
      response.headers.get('x-ratelimit-remaining') !== '0'
    )
      throw new DashboardError(403, 'GitHub repository access is unavailable');
    if (!response.ok)
      throw new DashboardError(
        503,
        'GitHub access could not be verified; try again',
      );
    return response.json();
  }
  async function pages(path: string, token: string, key: string) {
    const result: Record<string, any>[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request(`${path}?per_page=100&page=${page}`, token);
      if (!Array.isArray(data[key]))
        throw new DashboardError(503, 'Unexpected GitHub access response');
      result.push(...data[key]);
      if (data[key].length < 100) return result;
    }
    throw new DashboardError(
      503,
      'GitHub access listing exceeds the supported limit',
    );
  }
  return {
    async exchange(code) {
      const response = await fetcher(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: `${config.origin}/auth/github/callback`,
          }),
        },
      );
      const data = await response.json();
      if (
        !response.ok ||
        typeof data.access_token !== 'string' ||
        !data.access_token ||
        (data.expires_in !== undefined &&
          (!Number.isFinite(data.expires_in) || data.expires_in <= 0))
      )
        throw new DashboardError(
          401,
          'GitHub sign-in failed; please try again',
        );
      return {
        token: data.access_token,
        expiresIn: data.expires_in ?? 8 * 60 * 60,
      };
    },
    async identity(token) {
      const user = await request('/user', token);
      if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string')
        throw new DashboardError(503, 'GitHub identity unavailable');
      return { id: String(user.id), login: user.login };
    },
    async repositories(token) {
      const installations = await pages(
        '/user/installations',
        token,
        'installations',
      );
      const result: AccessibleRepository[] = [];
      for (const installation of installations) {
        if (installation.suspended_at) continue;
        const repositories = await pages(
          `/user/installations/${installation.id}/repositories`,
          token,
          'repositories',
        );
        for (const repo of repositories) {
          if (!Number.isSafeInteger(repo.id) || !repo.permissions?.pull)
            continue;
          result.push({
            id: String(repo.id),
            installationId: String(installation.id),
            owner: repo.owner.login,
            name: repo.name,
            maintainer:
              repo.permissions.admin === true ||
              repo.permissions.maintain === true,
            canPublish: installation.permissions?.pull_requests === 'write',
          });
        }
      }
      return result;
    },
  };
}
