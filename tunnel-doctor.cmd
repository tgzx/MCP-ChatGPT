@echo off
cd /d "%~dp0"

set PROFILE=mcp-chatgpt-full-pc-dev
set TUNNEL_CLIENT=%~dp0tunnel-client.exe

echo.
echo Profile: %PROFILE%
echo.
set /p CONTROL_PLANE_API_KEY=Cole sua Runtime API Key da OpenAI e pressione Enter: 

if "%CONTROL_PLANE_API_KEY%"=="" (
  echo Runtime API Key vazia. Abortando.
  pause
  exit /b 1
)

"%TUNNEL_CLIENT%" doctor --profile %PROFILE% --explain

echo.
echo Doctor finalizado.
pause
