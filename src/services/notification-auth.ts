import type { Env, JWTPayload } from '../types';
import { verifyJWT } from '../utils/jwt';

// Non-secret session context, never a bearer token. Only construct after JWT
// verification or consume from the server's signed, one-use ticket store.
export type NotificationSession = Pick<JWTPayload, 'sub' | 'sstamp' | 'exp' | 'did' | 'dstamp'>;

export function isNotificationSession(value: unknown): value is NotificationSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<NotificationSession>;
  return typeof v.sub === 'string' && !!v.sub && typeof v.sstamp === 'string' && !!v.sstamp
    && Number.isSafeInteger(v.exp) && Number(v.exp) > Math.floor(Date.now() / 1000)
    && (v.did === undefined
      ? v.dstamp === undefined
      : typeof v.did === 'string' && !!v.did && typeof v.dstamp === 'string' && !!v.dstamp);
}

export async function isNotificationSessionCurrent(value: unknown, env: Env): Promise<boolean> {
  if (!isNotificationSession(value)) return false;
  // Bypass AuthService's 15-second process cache for connections and deliveries.
  const user = await env.DB.prepare('SELECT status, security_stamp FROM users WHERE id = ?')
    .bind(value.sub).first<{ status: string; security_stamp: string }>();
  if (!user || user.status !== 'active' || user.security_stamp !== value.sstamp) return false;
  if (value.did) {
    const device = await env.DB.prepare('SELECT session_stamp, banned FROM devices WHERE user_id = ? AND device_identifier = ?')
      .bind(value.sub, value.did).first<{ session_stamp: string; banned: number }>();
    if (!device || device.banned === 1 || device.session_stamp !== value.dstamp) return false;
  }
  return isNotificationSession(value); // D1 I/O must not extend a token past exp.
}

export async function authenticateNotificationToken(token: string, env: Env): Promise<NotificationSession | null> {
  if (!token || token.length > 8192) return null;
  try {
    const encoded = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const header = JSON.parse(atob(encoded));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const payload = await verifyJWT(token, env.JWT_SECRET);
    const notBefore = (payload as (JWTPayload & { nbf?: unknown }) | null)?.nbf;
    if (!payload || payload.iss !== 'nodewarden' || !Number.isSafeInteger(payload.iat)
      || payload.iat > Math.floor(Date.now() / 1000)
      || (notBefore !== undefined && (!Number.isSafeInteger(notBefore) || Number(notBefore) > Math.floor(Date.now() / 1000)))) return null;
    const session: NotificationSession = {
      sub: payload.sub, sstamp: payload.sstamp, exp: payload.exp,
      ...(payload.did !== undefined ? { did: payload.did } : {}),
      ...(payload.dstamp !== undefined ? { dstamp: payload.dstamp } : {}),
    };
    return await isNotificationSessionCurrent(session, env) ? session : null;
  } catch {
    return null;
  }
}
