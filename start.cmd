@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0server.cjs" --desktop
  goto :finished
)
if exist "%~dp0runtime\bin\node.exe" (
  "%~dp0runtime\bin\node.exe" "%~dp0server.cjs" --desktop
  goto :finished
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please use the full portable package.
  pause
  exit /b 1
)
node.exe "%~dp0server.cjs" --desktop
:finished
if errorlevel 1 (
  echo NodeScope could not start. See the error above.
  pause
  exit /b 1
)
endlocal
