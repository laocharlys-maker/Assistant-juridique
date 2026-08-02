# Lot 2bis - Verification / activation de BitLocker sur le poste
# d'installation d'Aurore.
#
# Contexte : Aurore stocke des donnees sensibles (identites clients,
# contenu de dossiers juridiques) dans un PostgreSQL local, sur un
# PC/serveur physiquement chez le cabinet. Le chiffrement au repos applicatif
# (voir README-LOT2BIS.md) protege les colonnes sensibles meme si la base
# est exfiltree, mais ne protege PAS le reste du disque (fichiers exportes,
# sauvegardes pg_dump non chiffrees, fichier de cle lui-meme si le disque
# n'est pas chiffre) en cas de vol/perte physique du poste. BitLocker est le
# complement recommande pour cette classe de risque - ce script ne remplace
# pas le chiffrement applicatif, il le complete.
#
# Ce script est volontairement PRUDENT : par defaut il ne fait qu'un
# diagnostic (aucune modification du poste). L'activation reelle necessite
# le flag explicite -Enable ET une confirmation interactive, car activer
# BitLocker :
#   - necessite les droits Administrateur
#   - genere une cle de recuperation qui DOIT etre sauvegardee ailleurs que
#     sur ce meme disque (cle USB, compte Microsoft, Azure AD, ou papier
#     range en lieu sur) avant de continuer, sous peine de perte de donnees
#     irrecuperable en cas de probleme materiel
#   - peut necessiter un redemarrage et un chiffrement initial du disque qui
#     prend du temps (plusieurs heures sur un gros disque, en arriere-plan)
#
# Usage :
#   powershell -ExecutionPolicy Bypass -File installer\enable-bitlocker.ps1
#       -> diagnostic seul (recommande, y compris pendant l'installation)
#   powershell -ExecutionPolicy Bypass -File installer\enable-bitlocker.ps1 -Enable
#       -> propose l'activation, avec confirmation et sauvegarde de la cle
#          de recuperation affichee a l'ecran (a noter/imprimer immediatement)

param(
    [switch]$Enable
)

$ErrorActionPreference = "Stop"

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

Write-Section "Verification des prerequis"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Ce script doit etre execute en Administrateur (clic droit -> Executer en tant qu'administrateur)." -ForegroundColor Yellow
    Write-Host "Diagnostic limite possible sans droits admin, mais l'activation (-Enable) echouera."
}

$systemDrive = $env:SystemDrive
Write-Host "Lecteur systeme : $systemDrive"

# BitLocker n'existe pas sur les editions Windows Home (Pro/Enterprise/
# Education uniquement) - verification explicite pour un message clair
# plutot qu'une erreur PowerShell brute.
$edition = (Get-ComputerInfo -Property WindowsProductName -ErrorAction SilentlyContinue).WindowsProductName
Write-Host "Edition Windows detectee : $edition"
if ($edition -match "Home") {
    Write-Host ""
    Write-Host "BitLocker n'est PAS disponible sur Windows Home." -ForegroundColor Red
    Write-Host "Alternative : chiffrement de conteneur tiers (VeraCrypt) sur le dossier de donnees Aurore"
    Write-Host "(%APPDATA%\Aurore), ou mise a niveau vers Windows Pro. Voir README-LOT2BIS.md."
    exit 1
}

$blCommand = Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
if (-not $blCommand) {
    Write-Host "Le module BitLocker (Get-BitLockerVolume) n'est pas disponible sur ce poste." -ForegroundColor Red
    Write-Host "Verifier qu'il s'agit bien d'une edition Windows Pro/Enterprise/Education a jour."
    exit 1
}

Write-Section "Etat actuel de BitLocker sur $systemDrive"

$volume = Get-BitLockerVolume -MountPoint $systemDrive
$volume | Format-List MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage, KeyProtector

if ($volume.ProtectionStatus -eq "On") {
    Write-Host ""
    Write-Host "BitLocker est deja actif sur $systemDrive. Rien a faire." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "BitLocker n'est PAS actif sur $systemDrive." -ForegroundColor Yellow

if (-not $Enable) {
    Write-Host ""
    Write-Host "Checklist d'activation manuelle (recommandee, via l'interface Windows) :" -ForegroundColor Cyan
    Write-Host "  1. Panneau de configuration > Systeme et securite > Chiffrement de lecteur BitLocker"
    Write-Host "  2. Activer BitLocker sur $systemDrive"
    Write-Host "  3. Choisir 'Enregistrer dans un compte Microsoft' OU 'Imprimer la cle de recuperation'"
    Write-Host "     OU 'Enregistrer dans un fichier' (sur un support DIFFERENT de ce disque - cle USB dediee)"
    Write-Host "  4. Choisir 'Chiffrer la totalite du lecteur' (plus lent mais plus sur qu'un chiffrement partiel)"
    Write-Host "  5. Redemarrer si demande, puis laisser le chiffrement se terminer en arriere-plan"
    Write-Host ""
    Write-Host "Pour lancer l'activation depuis ce script (avec confirmation) : ajouter le flag -Enable" -ForegroundColor Cyan
    exit 0
}

Write-Section "Activation de BitLocker sur $systemDrive"

Write-Host "ATTENTION : cette operation genere une cle de recuperation obligatoire." -ForegroundColor Yellow
Write-Host "Elle sera affichee ci-dessous - la noter/imprimer et la ranger dans un endroit"
Write-Host "SUR et DIFFERENT de ce PC (cle USB dediee, coffre du cabinet...) AVANT de continuer."
$confirmation = Read-Host "Confirmer l'activation de BitLocker sur $systemDrive maintenant ? (taper 'oui' pour continuer)"
if ($confirmation -ne "oui") {
    Write-Host "Activation annulee."
    exit 0
}

Add-BitLockerKeyProtector -MountPoint $systemDrive -RecoveryPasswordProtector | Out-Null
Enable-BitLocker -MountPoint $systemDrive -EncryptionMethod XtsAes256 -UsedSpaceOnly:$false -SkipHardwareTest

$recovery = (Get-BitLockerVolume -MountPoint $systemDrive).KeyProtector | Where-Object { $_.KeyProtectorType -eq "RecoveryPassword" }

Write-Host ""
Write-Host "BitLocker active. CLE DE RECUPERATION (a conserver en lieu sur, hors de ce PC) :" -ForegroundColor Green
Write-Host $recovery.RecoveryPassword -ForegroundColor Green
Write-Host ""
Write-Host "Le chiffrement se poursuit en arriere-plan (voir 'manage-bde -status $systemDrive')."
Write-Host "Un redemarrage peut etre necessaire pour finaliser l'activation."
