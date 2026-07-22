import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface AuthTokenPayload {
  userId: string;
  cabinetId: string;
  role: "titulaire" | "avocat" | "collaborateur";
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.SESSION_SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.SESSION_SECRET) as AuthTokenPayload;
}
