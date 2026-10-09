import { execFile } from "node:child_process";
import path from "node:path";
import { appRoot } from "../../lib/seaPaths";

/**
 * Ouverture automatique du port mobile sur le pare-feu Windows (Option B,
 * choisie par l'utilisateur le 2026-10-09 - voir docs/lot10/01-protocole.md
 * section 6). Reutilise installer/firewall-rule.ps1 SANS LE MODIFIER (deja
 * parametrable par -Port, deja idempotent) plutot que de reimplementer la
 * logique de regle pare-feu en Node.
 *
 * Declenche une invite UAC Windows standard (Start-Process -Verb RunAs) -
 * NON TESTABLE dans cet environnement de developpement (pas de session
 * Windows interactive). A verifier par l'utilisateur a la premiere
 * activation du reglage "Synchronisation mobile".
 */

export interface ResultatOuverturePareFeu {
  ok: boolean;
  message: string;
}

function cheminScriptPareFeu(): string {
  // appRoot() pointe vers resource_dir() de Tauri en production (voir
  // lib/seaPaths.ts). ATTENTION : tauri.conf.json mappe cette ressource a
  // la RACINE du dossier de ressources ("../installer/firewall-rule.ps1":
  // "firewall-rule.ps1", PAS "installer/firewall-rule.ps1") - deja present
  // pour l'ecran "Mode reseau" existant, reutilise tel quel ici.
  return path.join(appRoot(), "firewall-rule.ps1");
}

/**
 * Non bloquant pour l'activation du reglage lui-meme : si cette fonction
 * echoue ou si l'utilisateur refuse l'elevation UAC, le reglage reste actif
 * cote base de donnees (jamais d'echec silencieux, mais jamais non plus un
 * blocage total de la fonctionnalite) - l'appelant (routes/mobileAppareils.ts)
 * renvoie le message a l'ecran pour que l'utilisateur sache qu'il doit
 * lancer le script lui-meme si l'automatisation a echoue.
 */
export function ouvrirPortPareFeu(port: number): Promise<ResultatOuverturePareFeu> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      // Mode reseau existant (Lot 6) est deja limite a Windows en pratique
      // (installeur NSIS) - pas la peine de tenter une commande Windows sur
      // une autre plateforme (ex: environnement de test Linux CI).
      resolve({ ok: false, message: "Ouverture automatique non applicable hors Windows." });
      return;
    }

    const script = cheminScriptPareFeu();
    // Start-Process -Verb RunAs : seul mecanisme standard pour demander une
    // elevation UAC depuis un process non-admin, sans dependance tierce.
    // -Wait pour que cette promesse ne se resolve qu'une fois la regle
    // reellement creee (ou l'invite refusee).
    const argumentsPowerShell = [
      "-NoProfile",
      "-Command",
      `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','-Port','${port}','-Force'`,
    ];

    execFile("powershell", argumentsPowerShell, { timeout: 30000 }, (error) => {
      if (error) {
        resolve({
          ok: false,
          message: `Ouverture automatique du port ${port} impossible (invite d'administration refusée ou erreur). Lance "installer\\firewall-rule.ps1 -Port ${port}" toi-même, en administrateur.`,
        });
        return;
      }
      resolve({ ok: true, message: `Port ${port} ouvert sur le profil réseau privé.` });
    });
  });
}
