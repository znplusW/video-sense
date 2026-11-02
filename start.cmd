@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0src\bootstrap.mjs" %*
) else if exist "%~dp0runtime\node\node.exe" (
  "%~dp0runtime\node\node.exe" "%~dp0src\bootstrap.mjs" %*
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js 20+ required. Install it or place node.exe in runtime. 1>&2
    exit /b 1
  )
  node "%~dp0src\bootstrap.mjs" %*
)
exit /b %errorlevel%
