@echo off
where node >nul 2>nul || (
  echo Node.js 18 or later is required.
  exit /b 1
)
node "%~dp0app\cli.js" install %*
exit /b %errorlevel%
