@echo off
cd /d "%~dp0"
npm install
npx playwright install chromium
echo.
echo Dependencias instaladas.
pause
