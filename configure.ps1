param(
  [ValidateSet('generic','codex','workbuddy')][string]$Client='generic',
  [string]$ConfigDir,
  [string]$NodePath,
  [string]$FfmpegPath,
  [string]$FfprobePath,
  [string]$DataDir,
  [string]$AsrConfig,
  [string]$OutputDir
)
$ErrorActionPreference = 'Stop'
function Find-Runtime([string]$Name,[string[]]$Candidates) {
  foreach($candidate in $Candidates){$file=Join-Path $PSScriptRoot $candidate;if(Test-Path -LiteralPath $file -PathType Leaf){return $file}}
  $found=Get-Command $Name -ErrorAction SilentlyContinue
  if($found){return $found.Source}
  throw "$Name is missing. Install it on PATH, or place its executable under runtime."
}
if (-not $NodePath) { $NodePath = Find-Runtime node @('runtime/node.exe','runtime/node/node.exe') }
if (-not $FfmpegPath) { $FfmpegPath = Find-Runtime ffmpeg @('runtime/ffmpeg.exe','runtime/bin/ffmpeg.exe','runtime/ffmpeg/bin/ffmpeg.exe') }
if (-not $FfprobePath) { $FfprobePath = Find-Runtime ffprobe @('runtime/ffprobe.exe','runtime/bin/ffprobe.exe','runtime/ffmpeg/bin/ffprobe.exe') }
if ($ConfigDir -and $OutputDir) { throw 'Specify ConfigDir or its legacy alias OutputDir, not both.' }
if ($OutputDir) { $ConfigDir=$OutputDir }
if (-not $ConfigDir) {
  $userRoot=[Environment]::GetFolderPath('UserProfile')
  $ConfigDir=switch($Client) {
    'codex' { Join-Path $userRoot '.codex/video-sense' }
    'workbuddy' { Join-Path $userRoot '.workbuddy/video-sense' }
    default { $configBase=if($env:XDG_CONFIG_HOME){$env:XDG_CONFIG_HOME}else{Join-Path $userRoot '.config'}; Join-Path $configBase 'video-sense/generic' }
  }
}
$ConfigDir=[IO.Path]::GetFullPath($ConfigDir)
$sharedRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')
if ($ConfigDir -eq $sharedRoot -or $ConfigDir.StartsWith($sharedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Client configuration must be outside the shared runtime directory. Choose a client-owned ConfigDir.'
}
if (-not $DataDir) { $DataDir=Join-Path $ConfigDir 'data' }
$DataDir=[IO.Path]::GetFullPath($DataDir)
if ($DataDir -eq $sharedRoot -or $DataDir.StartsWith($sharedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Task data must be outside the shared runtime directory. Choose a client-owned DataDir.'
}
foreach ($exe in @($NodePath,$FfmpegPath,$FfprobePath)) {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Executable missing: $exe" }
}
$NodePath=[IO.Path]::GetFullPath($NodePath)
$FfmpegPath=[IO.Path]::GetFullPath($FfmpegPath)
$FfprobePath=[IO.Path]::GetFullPath($FfprobePath)
$server = Join-Path $PSScriptRoot 'src/bootstrap.mjs'
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
$runtimeEnv=[ordered]@{
  AGENT_VIDEO_FFMPEG=$FfmpegPath.Replace('\','/')
  AGENT_VIDEO_FFPROBE=$FfprobePath.Replace('\','/')
  AGENT_VIDEO_CONFIG_DIR=$ConfigDir.Replace('\','/')
  AGENT_VIDEO_DATA_DIR=$DataDir.Replace('\','/')
}
if ($AsrConfig) {
  if (-not [IO.Path]::IsPathRooted($AsrConfig)) { $AsrConfig=Join-Path $ConfigDir $AsrConfig }
  $runtimeEnv.AGENT_VIDEO_ASR_CONFIG=[IO.Path]::GetFullPath($AsrConfig).Replace('\','/')
}
$command = ConvertTo-Json -InputObject $NodePath.Replace('\','/') -Compress
$entry = ConvertTo-Json -InputObject $server.Replace('\','/') -Compress
if ($Client -eq 'codex') {
  $content = @"
[mcp_servers.video-sense]
command = $command
args = [$entry]
tool_timeout_sec = 45

[mcp_servers.video-sense.env]
"@
  foreach ($key in $runtimeEnv.Keys) { $content += "`n$key = " + (ConvertTo-Json -InputObject $runtimeEnv[$key] -Compress) }
  $content += "`n"
  $name='mcp.toml'
} else {
  $connection=[ordered]@{command=$NodePath.Replace('\','/');args=@($server.Replace('\','/'));env=$runtimeEnv}
  if ($Client -eq 'workbuddy') { $connection.type='stdio' }
  $content=(@{mcpServers=@{'video-sense'=$connection}} | ConvertTo-Json -Depth 6)+"`n"
  $name='mcp.json'
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Save-Config([string]$Name,[string]$Text) {
  $target = Join-Path $ConfigDir $Name
  if (Test-Path -LiteralPath $target) {
    Copy-Item -LiteralPath $target -Destination ($target + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.' + [guid]::NewGuid().ToString('N') + '.bak')
  }
  [IO.File]::WriteAllText($target,$Text,$utf8)
}
Save-Config $name $content
$manifest=[ordered]@{schemaVersion=1;client=$Client;sharedRuntime=$PSScriptRoot;entry=$server;configDir=$ConfigDir;dataDir=$DataDir;snippet=(Join-Path $ConfigDir $name);asrConfig=if($AsrConfig){$runtimeEnv.AGENT_VIDEO_ASR_CONFIG}else{Join-Path $ConfigDir 'asr.json'};asrExplicit=[bool]$AsrConfig}
Save-Config 'client-config.json' (($manifest|ConvertTo-Json -Depth 4)+"`n")
Write-Output "Created $name under $ConfigDir. Merge its video-sense entry into your MCP client, then reconnect. Existing host configuration was not changed."
Write-Output "Shared runtime: $PSScriptRoot"
