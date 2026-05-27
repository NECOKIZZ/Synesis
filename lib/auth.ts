/**
 * JWT session helpers — Next.js App Router edition.
 *
 * Uses `jose` (works in both Node and Edge runtimes) and Next's
 * `cookies()` API. Replaces the Express-bound implementation we had
 * in the .arc monorepo.
 */

import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "dotarc_session";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return new TextEncoder().encode(secret);
}

export type Session = {
  userId: string;
  email: string;
  walletAddress: string;
  arcName?: string | null;
};

export async function signSession(payload: Session): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getKey());
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getKey());
    const p = payload as unknown as Session;
    if (!p.userId || !p.email || !p.walletAddress) return null;
    return {
      userId: p.userId,
      email: p.email,
      walletAddress: p.walletAddress,
      arcName: p.arcName ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read the current session from cookies. Returns `null` if absent or invalid.
 * Use in route handlers and server components.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return await verifySession(token);
}

/**
 * Require a valid session. Throws a 401 Response if missing — callers should
 * let it propagate. Returns the session if present.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return session;
}

/**
 * Set the session cookie. Must be called from a Server Action or route handler.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TTL_SECONDS,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
