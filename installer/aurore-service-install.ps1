# Lot 6 - Installe Aurore comme service Windows via NSSM (Non-Sucking
# Service Manager), pour un poste serveur "sans ecran" (mini-PC dedie,
# mode "service pur" - sans la coquille Tauri). Demarre automatiquement au
# demarrage de Windows, SANS session utilisateur ouverte, et redemarre
# automatiquement en cas de crash. Voir README-LOT6.md "Mode service pur".
#
# Difference avec le mode Tauri (confort, icone, tray) : les deux sont des
# options valides selon le contexte - le mode service pur convient a un
# mini-PC dedie sans ecran branche en permanence ; le mode Tauri convient a
# un poste de travail normal qui sert AUSSI de serveur reseau.
#
# PREREQUIS :
#   - NSSM (https://nssm.cc/download) - outil tiers largement utilise,
#     telecharger nssm.exe (version 64 bits) et le placer sur le PATH, ou
#     a cote de ce script, ou fournir -NssmPath.
#   - Le dossier de build SEA complet (dist-sea/, voir README-LOT1.md)
#     copie sur ce poste (ex: C:\Aurore\) - doit contenir aurore-backend.exe,
#     public/, node_modules/, postgres/, prisma/ tous a cote les uns des
#     autres (jamais deplaces individuellement, voir lib/seaPaths.ts).
#
# Usage :
#   powershell -ExecutionPolicy Bypass -File installer\aurore-service-install.ps1 -InstallDir "C:\Aurore"
#   powershell -ExecutionPolicy Bypass -File installer\aurore-service-install.ps1 -InstallDir "C:\Aurore" -Uninstall
#
# Verification apres installation :
#   Get-Service Aurore
#   sc.exe qc Aurore

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,
    [string]$NssmPath = "nssm.exe",
    [int]$Port = 3000,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ServiceName = "Aurore"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Ce script doit etre execute en Administrateur (clic droit -> Executer en tant qu'administrateur)." -ForegroundColor Red
    exit 1
}

function Resolve-Nssm {
    param([string]$Hint)
    $cmd = Get-Command $Hint -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $siblingPath = Join-Path $PSScriptRoot "nssm.exe"
    if (Test-Path $siblingPath) { return $siblingPath }
    throw "nssm.exe introuvable. Telecharger NSSM (https://nssm.cc/download), placer nssm.exe a cote de ce script (ou sur le PATH), ou fournir -NssmPath <chemin>."
}

if ($Uninstall) {
    Write-Host "Desinstallation du service '$ServiceName'..."
    $nssm = Resolve-Nssm -Hint $NssmPath
    & $nssm stop $ServiceName confirm 2>$null
    & $nssm remove $ServiceName confirm
    Write-Host "Service supprime." -ForegroundColor Green
    exit 0
}

$exePath = Join-Path $InstallDir "aurore-backend.exe"
if (-not (Test-Path $exePath)) {
    throw "aurore-backend.exe introuvable dans '$InstallDir'. Verifier que le dossier dist-sea/ complet (voir README-LOT1.md) y a bien ete copie en integralite."
}

$nssm = Resolve-Nssm -Hint $NssmPath
Write-Host "NSSM : $nssm"
Write-Host "Executable Aurore : $exePath"

# Idempotent : si le service existe deja, on l'arrete et le retire avant
# de le reinstaller, plutot que d'echouer ou de le dupliquer.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Le service '$ServiceName' existe deja - arret et suppression avant reinstallation."
    & $nssm stop $ServiceName confirm 2>$null
    & $nssm remove $ServiceName confirm
}

& $nssm install $ServiceName $exePath

& $nssm set $ServiceName AppDirectory $InstallDir
# AppEnvironmentExtra attend UNE chaine, variables separees par des sauts de
# ligne (pas plusieurs arguments) - DATABASE_MODE=portable declenche le
# meme chemin d'amorcage Postgres portable + choix de binding reseau
# (Lot 6) que le sidecar Tauri : aucune logique dupliquee, voir index.ts.
& $nssm set $ServiceName AppEnvironmentExtra "DATABASE_MODE=portable`nPORT=$Port"
& $nssm set $ServiceName DisplayName "Aurore (serveur cabinet)"
& $nssm set $ServiceName Description "Backend Aurore en mode service pur (Lot 6) - demarre automatiquement au demarrage de Windows, sans session utilisateur ouverte."
& $nssm set $ServiceName Start SERVICE_AUTO_START

# Journaux de diagnostic, avec rotation (evite un fichier illimite au fil
# des mois/annees).
$logDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $logDir "service-stdout.log")
& $nssm set $ServiceName AppStderr (Join-Path $logDir "service-stderr.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760

# Redemarrage automatique en cas de crash (comportement par defaut de NSSM,
# rendu explicite ici), avec un court delai pour eviter une boucle de
# redemarrage trop rapprochee si le crash survient immediatement (ex:
# Postgres portable pas encore pret).
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000

Write-Host ""
Write-Host "Service '$ServiceName' installe." -ForegroundColor Green
Write-Host "Demarrage..."
& $nssm start $ServiceName

Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Format-List Name, Status, StartType | Out-String | Write-Host
Write-Host "Verifier le health-check : Invoke-RestMethod http://127.0.0.1:$Port/health (ou https:// en mode reseau, avec -SkipCertificateCheck)"
Write-Host "Journaux : $logDir"
Write-Host "Pour desinstaller : powershell -ExecutionPolicy Bypass -File installer\aurore-service-install.ps1 -Uninstall"
