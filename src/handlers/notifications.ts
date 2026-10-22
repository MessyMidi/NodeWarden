import { StorageService } from '../services/storage';
import { isAuthRequestExpired } from '../services/storage-auth-request-repo';
import type { Env } from '../types';
import { authenticateNotificationToken, isNotificationSessionCurrent, type NotificationSession } from '../services/notification-auth';
import { errorResponse, jsonResponse } from '../utils/response';
import { generateUUID } from '../utils/uuid';
import {
  createWebSocketConnectionToken,
  verifyWebSocketConnectionToken,
} from '../utils/websocket-connection-token';

const WEBSOCKET_CONNECTION_TOKEN_TTL_MS = 60 * 1000;

function extractAccessToken(request: Request): string | null {
  const authHeader = String(request.headers.get('Authorization') || '').trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function authenticateAccessToken(request: Request, env: Env): Promise<NotificationSession | null> {
  const accessToken = extractAccessToken(request);
  if (!accessToken) return null;

  return authenticateNotificationToken(accessToken, env);
}

async function issueWebSocketConnectionToken(payload: NotificationSession, env: Env): Promise<string> {
  const expiresAt = Math.min(Date.now() + WEBSOCKET_CONNECTION_TOKEN_TTL_MS, payload.exp * 1000);
  const token = await createWebSocketConnectionToken(payload.sub, expiresAt, env.JWT_SECRET);
  const id = env.NOTIFICATIONS_HUB.idFromName(payload.sub);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const response = await stub.fetch('https://notifications/internal/ws-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      userId: payload.sub,
      deviceIdentifier: payload.did || null,
      expiresAt,
      session: payload,
    }),
  });
  if (!response.ok) throw new Error('Failed to issue websocket connection token');
  return token;
}

async function consumeWebSocketConnectionToken(request: Request, env: Env): Promise<NotificationSession | null> {
  const token = String(new URL(request.url).searchParams.get('id') || '').trim();
  const claims = await verifyWebSocketConnectionToken(token, env.JWT_SECRET);
  if (!claims) return null;

  // Verify the signed routing claim before selecting a Durable Object. Otherwise an
  // attacker could activate arbitrary object names with forged token prefixes.
  const id = env.NOTIFICATIONS_HUB.idFromName(claims.userId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const response = await stub.fetch('https://notifications/internal/ws-token/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return null;

  const connection = (await response.json().catch(() => null)) as {
    userId?: string;
    deviceIdentifier?: string | null;
    session?: NotificationSession;
  } | null;
  if (connection?.userId !== claims.userId || connection.session?.sub !== claims.userId) return null;
  return await isNotificationSessionCurrent(connection.session, env) ? connection.session : null;
}

async function authenticateNotificationsHub(request: Request, env: Env): Promise<NotificationSession | null> {
  // Explicit credentials fail closed: no fallback from a bad header or ticket.
  if (request.headers.has('Authorization')) {
    return authenticateAccessToken(request, env);
  }
  const query = new URL(request.url).searchParams;
  if (query.has('id')) return query.getAll('id').length === 1 ? consumeWebSocketConnectionToken(request, env) : null;
  const tokens = query.getAll('access_token');
  return tokens.length === 1 ? authenticateNotificationToken(tokens[0], env) : null;
}

export async function handleNotificationsNegotiate(request: Request, env: Env): Promise<Response> {
  const payload = await authenticateAccessToken(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const connectionToken = await issueWebSocketConnectionToken(payload, env);
  return jsonResponse(
    {
      connectionId: generateUUID(),
      connectionToken,
      negotiateVersion: 1,
      availableTransports: [
        {
          transport: 'WebSockets',
          transferFormats: ['Text', 'Binary'],
        },
      ],
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

export async function handleNotificationsHub(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== '/notifications/hub' || request.method !== 'GET') {
    return errorResponse('Not found', 404);
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }
  const payload = await authenticateNotificationsHub(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const userId = payload.sub;
  const id = env.NOTIFICATIONS_HUB.idFromName(userId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  // Official clients cannot set Authorization on a browser WebSocket. Accept
  // their URL JWT only here, then discard all client query parameters internally.
  const forwardedUrl = new URL('https://notifications/notifications/hub');
  forwardedUrl.searchParams.set('nw_uid', userId);
  if (payload.did) {
    forwardedUrl.searchParams.set('nw_did', payload.did);
  }
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.delete('Cookie');
  headers.delete('Referer');
  headers.set('X-NodeWarden-Session', JSON.stringify(payload));
  return stub.fetch(new Request(forwardedUrl.toString(), { method: 'GET', headers }));
}

export async function handleAnonymousNotificationsHub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const authRequestId = String(url.searchParams.get('Token') || url.searchParams.get('token') || '').trim();
  if (!authRequestId) return errorResponse('Token is required', 400);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }

  const storage = new StorageService(env.DB);
  const authRequest = await storage.getAuthRequestById(authRequestId);
  if (!authRequest || isAuthRequestExpired(authRequest)) {
    return errorResponse('Not found', 404);
  }

  const id = env.NOTIFICATIONS_HUB.idFromName(authRequestId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const forwardedUrl = new URL('https://notifications/notifications/anonymous-hub');
  forwardedUrl.searchParams.set('nw_auth_request_id', authRequestId);
  const headers = new Headers(request.headers);
  for (const name of ['Authorization', 'Cookie', 'Referer', 'X-NodeWarden-Session']) headers.delete(name);
  return stub.fetch(new Request(forwardedUrl.toString(), { method: 'GET', headers }));
}
