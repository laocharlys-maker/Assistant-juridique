export function splitSujets(sujetsBruts: string): string[] {
  return sujetsBruts
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function periodeLabel(now = new Date()): string {
  const debut = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const format = (d: Date) => d.toLocaleDateString("fr-FR");
  return `${format(debut)} au ${format(now)}`;
}
