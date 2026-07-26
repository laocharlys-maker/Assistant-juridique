import { formatDateLongue } from "../utils/dateFormat";

export function splitSujets(sujetsBruts: string): string[] {
  return sujetsBruts
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function periodeLabel(now = new Date()): string {
  const debut = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return `${formatDateLongue(debut)} au ${formatDateLongue(now)}`;
}
