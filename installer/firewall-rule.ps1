# Lot 6 - Ouvre le port Aurore sur le profil reseau "Prive" UNIQUEMENT
# (jamais "Public" ni "Domaine" sans confirmation supplementaire - un WiFi
# partage/mal configure ne doit jamais exposer Aurore a l'exterieur).
#
# Idempotent : peut etre execute plusieurs fois sans dupliquer la regle
# (supprime puis recree la regle existante si elle existe deja).
#
# Usage :
#   powershell -ExecutionPolicy Bypass -File installer\firewall-rule.ps1
#       -> demande confirmation avant de creer la regle (port 3000 par defaut)
#   powershell -ExecutionPolicy Bypass -File installer\firewall-rule.ps1 -Port 3000 -Force
#       -> sans confirmation interactive (installeur automatise)
#   powershell -ExecutionPolicy Bypass -File installer\firewall-rule.ps1 -Remove
#       -> supprime la regle (retour au mode poste unique)
#
# Verification apres execution :
#   Get-NetFirewallRule -DisplayName "Aurore - Serveur reseau*" | Format-List DisplayName, Profile, Action, Enabled

param(
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$RuleName = "Aurore - Serveur reseau (TCP $Port, prive uniquement)"

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Ce script doit etre execute en Administrateur (clic droit -> Executer en tant qu'administrateur)." -ForegroundColor Red
    exit 1
}

if ($Remove) {
    Write-Section "Suppression de la regle pare-feu Aurore"
    $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Remove-NetFirewallRule
        Write-Host "Regle supprimee." -ForegroundColor Green
    } else {
        Write-Host "Aucune regle Aurore trouvee (rien a supprimer)."
    }
    exit 0
}

Write-Section "Verification du profil reseau actif"
$profiles = Get-NetConnectionProfile
$profiles | Format-Table -AutoSize InterfaceAlias, NetworkCategory | Out-String | Write-Host

$profilsNonPrives = $profiles | Where-Object { $_.NetworkCategory -ne "Private" }
if ($profilsNonPrives) {
    Write-Host "ATTENTION : au moins une interface reseau n'est PAS classee 'Privee' :" -ForegroundColor Yellow
    $profilsNonPrives | ForEach-Object { Write-Host "  - $($_.InterfaceAlias) : $($_.NetworkCategory)" -ForegroundColor Yellow }
    Write-Host "La regle pare-feu ci-dessous ne s'appliquera qu'au profil 'Prive' : Aurore ne sera PAS" -ForegroundColor Yellow
    Write-Host "accessible depuis une interface classee 'Publique' ou 'Domaine'." -ForegroundColor Yellow
    Write-Host "Si l'une de ces interfaces est en realite le reseau du cabinet, reclassez-la :" -ForegroundColor Yellow
    Write-Host "  Parametres Windows > Reseau et Internet > [votre reseau] > Profil reseau > Prive" -ForegroundColor Yellow
}

Write-Section "Regle pare-feu"
Write-Host "Cette operation va ouvrir le port TCP $Port en entree, UNIQUEMENT sur le profil reseau 'Prive'."
Write-Host "Le port restera ferme sur les profils 'Public' et 'Domaine'."

if (-not $Force) {
    $confirmation = Read-Host "Confirmer l'ouverture du port $Port sur le profil prive ? (taper 'oui' pour continuer)"
    if ($confirmation -ne "oui") {
        Write-Host "Annule."
        exit 0
    }
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Une regle Aurore existe deja pour ce port - suppression avant recreation (idempotence)."
    $existing | Remove-NetFirewallRule
}

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Private `
    -Description "Ouvre le port Aurore (mode serveur reseau, Lot 6) sur le profil reseau prive uniquement. Genere par installer/firewall-rule.ps1 - supprimer avec -Remove." `
    | Out-Null

Write-Host ""
Write-Host "Regle creee avec succes." -ForegroundColor Green

Write-Section "Verification"
Get-NetFirewallRule -DisplayName $RuleName | Format-List DisplayName, Direction, Action, Profile, Enabled | Out-String | Write-Host
Write-Host "Pour verifier a nouveau plus tard : Get-NetFirewallRule -DisplayName `"$RuleName`""
Write-Host "Pour revenir en arriere : powershell -ExecutionPolicy Bypass -File installer\firewall-rule.ps1 -Remove"
