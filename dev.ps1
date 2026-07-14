# dev.ps1 — carga el .env y arranca el servidor local en http://localhost:8080
# Uso:  ./dev.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Write-Error "No existe .env (copia .env.example)"; exit 1 }

# Cargar variables desde .env a la sesion actual
Get-Content .env | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $idx = $line.IndexOf('=')
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim()
    if ($v -match '^([^#\s]+)\s+#') { $v = $Matches[1] }  # quita comentario inline
    Set-Item -Path "Env:$k" -Value $v
  }
}

Write-Host "Arrancando servidor en http://localhost:8080  (Ctrl+C para detener)" -ForegroundColor Green
node server.js
