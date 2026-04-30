param(
  [string]$ServiceName = "AgentHero"
)

$script = Join-Path $PSScriptRoot "update-agent-hero.ps1"
& $script -ServiceName $ServiceName
exit $LASTEXITCODE
