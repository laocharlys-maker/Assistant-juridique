// Cles de modules geres par la plateforme - toute autre valeur est rejetee
// a la creation/modification pour eviter des cles orphelines qu'aucun
// module ne verifie jamais. Extrait de routes/admin.ts (re-exporte depuis
// la-bas pour ne rien casser des imports existants) - security/licenceManager.ts
// a aussi besoin de cette liste (synchronisation depuis le fichier de
// licence) et ne doit jamais importer un fichier de routes/.
//
// Les 6 dernieres cles ("action_...") sont plus fines que les precedentes :
// elles ne coupent pas toute la page "Nouvelle Action" (deja couverte par
// "nouvelle_action" ci-dessous), mais UNE action precise a l'interieur -
// verifiees en plus de "nouvelle_action", jamais a sa place (voir
// routes/webActions.ts, ACTION_MODULE_MAP, et routes/documentsDossier.ts
// pour "action_transcription").
export const MODULES_DISPONIBLES = [
  "facturation",
  "veille_juridique",
  "jurisprudence",
  "delais",
  "nouvelle_action",
  "documents_generes",
  "action_rediger",
  "action_recherche_juridique",
  "action_recherche_jurisprudence",
  "action_resume_jurisprudence",
  "action_transcription",
  "action_traduction",
] as const;

export type ModuleDisponible = (typeof MODULES_DISPONIBLES)[number];
