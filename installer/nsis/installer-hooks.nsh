; Hooks NSIS personnalises pour l'installeur Aurore (Lot 8).
; Reference depuis src-tauri/tauri.conf.json (bundle.windows.nsis.hooks) -
; Tauri insere automatiquement ces macros aux points correspondants du
; script d'installation/desinstallation qu'il genere. Voir la documentation
; Tauri v2 "NSIS hooks" pour la liste complete des macros disponibles.
;
; IMPORTANT (voir README-LOT8.md) : ce fichier n'a pas pu etre compile ni
; teste dans l'environnement de developpement de ce lot (NSIS et le CLI
; Tauri necessitent Rust/Cargo, absents ici - meme limite deja documentee
; au Lot 1). Ecrit en suivant precisement la syntaxe NSIS et les
; conventions Tauri v2 connues, a valider au premier vrai build.
;
; Ce que ce fichier NE fait PAS et n'a PAS besoin de faire :
; - "Installer" PostgreSQL portable n'importe quelle fenetre technique
;   visible : les binaires Postgres (backend/vendor/postgres, prepares par
;   `npm run postgres:download-binaries` avant le build - voir README-LOT2.md)
;   sont deja de simples fichiers copies par le bundler Tauri comme n'importe
;   quelle autre ressource (voir tauri.conf.json, bundle.resources) - jamais
;   un executable d'installation Postgres classique lance a part. La vraie
;   initialisation de la base (initdb, creation du role/schema) se fait de
;   facon silencieuse et automatique au tout premier lancement de
;   l'application (voir backend/src/database/initCluster.ts, deja teste aux
;   Lots 2/6/7) - rien a orchestrer ici au niveau de l'installeur.

!macro NSIS_HOOK_POSTINSTALL
  ; Verification defensive : confirme que le dossier "postgres" (binaires
  ; portables) a bien ete copie par le bundler avant de continuer -
  ; permet de detecter tot un build fait sans `npm run postgres:download-binaries`
  ; prealable (voir README-LOT2.md "Contournement pgvector"), plutot que de
  ; laisser l'utilisateur decouvrir l'echec au premier lancement de l'app.
  IfFileExists "$INSTDIR\postgres\*.*" postgres_ok postgres_missing
  postgres_missing:
    DetailPrint "Attention : dossier postgres/ absent de l'installation - le mode Poste unique/Serveur reseau ne pourra pas demarrer sa base de donnees locale."
    Goto postgres_done
  postgres_ok:
    DetailPrint "Binaires PostgreSQL portables presents - OK."
  postgres_done:

  ; Checklist BitLocker (Lot 2bis) : etape PUREMENT INFORMATIVE, jamais une
  ; activation automatique - BitLocker necessite des droits administrateur
  ; ET un redemarrage, et une automatisation ratee pourrait rendre le poste
  ; inutilisable. On affiche donc un simple rappel avec un lien vers la
  ; procedure officielle Windows, jamais plus. Voir
  ; installer/README-BITLOCKER.md pour le detail complet remis a
  ; l'utilisateur (copie a cote de l'executable, voir bundle.resources).
  MessageBox MB_ICONINFORMATION|MB_OK \
    "Aurore est installe.$\r$\n$\r$\nRappel securite : si cet ordinateur contient des donnees de dossiers/clients, pensez a activer le chiffrement de disque BitLocker de Windows (Parametres Windows > Confidentialite et securite > Chiffrement de l'appareil).$\r$\n$\r$\nDetails complets : README-BITLOCKER.md, installe a cote d'Aurore."
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Rien de special requis avant la copie des fichiers - conserve pour
  ; completude/coherence avec les autres macros de hook Tauri.
!macroend

; ============================================================================
; Desinstallation (Lot 8) : choix explicite conserver/supprimer les donnees.
;
; L'installeur NSIS demande deja, par defaut, "Voulez-vous vraiment
; desinstaller Aurore ?" AVANT que ce hook ne s'execute - la question
; ci-dessous concerne UNIQUEMENT les donnees du cabinet (base de donnees
; portable, cle de chiffrement, licence, sauvegardes - tout ce qui vit dans
; $APPDATA\Aurore, jamais dans $INSTDIR qui ne contient que le programme
; lui-meme). Deux confirmations bien distinctes, jamais fusionnees, et
; JAMAIS de suppression de donnees sans un second "Oui" explicite - voir
; README-LOT8.md et le prompt de ce lot ("ne jamais supprimer la base de
; donnees sans confirmation explicite et distincte").
; ============================================================================

!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Voulez-vous conserver les données de votre cabinet (dossiers, clients, documents générés) pour une éventuelle réinstallation future ?$\r$\n$\r$\nOui = conserver ces données sur ce disque (recommandé)$\r$\nNon = tout supprimer définitivement" \
    IDYES aurore_keep_data

  ; Deuxieme confirmation, distincte et plus explicite - jamais de
  ; suppression sur un simple "Non" a la question ci-dessus, qui pourrait
  ; etre un clic hâtif. Le "Non" par defaut ci-dessous conserve les
  ; donnees si l'utilisateur hesite ou ferme la boite par erreur.
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "ATTENTION : ceci supprimera DÉFINITIVEMENT tous les dossiers, clients et documents enregistrés dans Aurore sur cet ordinateur. Cette action est IRRÉVERSIBLE.$\r$\n$\r$\nConfirmez-vous la suppression complète des données ?" \
    IDYES aurore_delete_data
  Goto aurore_keep_data

  aurore_delete_data:
    RMDir /r "$APPDATA\Aurore"
    DetailPrint "Donnees Aurore (base, cle de chiffrement, licence, sauvegardes) supprimees de $APPDATA\Aurore."
    Goto aurore_data_choice_done

  aurore_keep_data:
    DetailPrint "Donnees Aurore conservees dans $APPDATA\Aurore (reinstallation future possible)."

  aurore_data_choice_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Rien d'autre a faire ici : le choix conserver/supprimer est deja
  ; traite dans NSIS_HOOK_PREUNINSTALL, avant la suppression des fichiers
  ; du programme lui-meme.
!macroend
