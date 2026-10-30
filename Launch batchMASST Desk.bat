@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto end
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 22.13 or newer ^(including npm^) from https://nodejs.org, then launch again.
) else (
  node launch.mjs
)
popd
:end
pause
