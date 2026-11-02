param(
  [ValidateSet('generic','codex','workbuddy')][string]$Client='generic',
  [string]$ConfigDir,[string]$OutputDir,[string]$NodePath,[string]$FfmpegPath,[string]$FfprobePath,
  [string]$DataDir,[string]$AsrConfig,[string]$SkillDir,[switch]$SkipSkill
)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'configure.ps1') -Client $Client -ConfigDir $ConfigDir -OutputDir $OutputDir -NodePath $NodePath -FfmpegPath $FfmpegPath -FfprobePath $FfprobePath -DataDir $DataDir -AsrConfig $AsrConfig
if($SkillDir -and -not $SkipSkill){
  $SkillDir=[IO.Path]::GetFullPath($SkillDir)
  $sourceSkill=Join-Path $PSScriptRoot 'skills/video-sense'
  if($SkillDir -eq [IO.Path]::GetFullPath($sourceSkill)){Write-Output "Use the shared Skill directly: $SkillDir";exit 0}
  if(Test-Path -LiteralPath $SkillDir){Copy-Item -LiteralPath $SkillDir -Destination ($SkillDir+'.backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.'+[guid]::NewGuid().ToString('N')) -Recurse}
  New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null
  Copy-Item -Path (Join-Path $PSScriptRoot 'skills/video-sense/*') -Destination $SkillDir -Recurse -Force
  Write-Output "Shared Skill installed: $SkillDir. Point each host's Skill discovery at this one directory, or link to it."
}
Write-Output 'MCP works without a Skill. No runtime source was copied; every generated client entry points to this shared package.'
