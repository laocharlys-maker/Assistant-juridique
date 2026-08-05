import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface AuthTokenPayload {
  userId: string;
  cabinetId: string;
  role: "titulaire" | "avocat" | "collaborateur" | "super_admin";
  serverSessionEpoch?: string;
}

/**
 * Identifiant unique regenere a chaque demarrage du process backend
 * (uniquement en mode desktop portable - voir resetServerSessionEpoch()
 * appelee depuis index.ts). Reste `null` en mode VPS/externe : le
 * comportement historique (session JWT valide 7 jours, y compris a travers
 * un redemarrage du serveur - normal pour un service partage) n'est pas
 * touche.
 *
 * En mode desktop, une session de 7 jours qui survit a la fermeture
 * complete de l'app est un vrai probleme de securite pour une app de
 * gestion de dossiers juridiques confidentiels : n'importe qui avec un
 * acces physique au poste rouvre l'app et voit tout, sans jamais avoir a
 * saisir de mot de passe. Plutot que raccourcir arbitrairement la duree du
 * cookie (perdant le confort de rester connecte pendant UNE session de
 * travail), chaque jeton porte l'epoch du demarrage serveur qui l'a emis -
 * un jeton emis par un demarrage precedent est rejete immediatement des le
 * suivant, sans attendre son expiration naturelle.
 */
let serverSessionEpoch: string | null = null;

export function resetServerSessionEpoch(): void {
  serverSessionEpoch = crypto.randomUUID();
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAuthToken(payload: Omit<AuthTokenPayload, "serverSessionEpoch">): string {
  return jwt.sign({ ...payload, serverSessionEpoch: serverSessionEpoch ?? undefined }, env.SESSION_SECRET, {
    expiresIn: "7d",
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, env.SESSION_SECRET) as AuthTokenPayload;
  if (serverSessionEpoch && payload.serverSessionEpoch !== serverSessionEpoch) {
    throw new Error("Session emise avant le dernier demarrage de l'application - reauthentification requise.");
  }
  return payload;
}
