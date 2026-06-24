@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set DEFAULT_TUNNEL_ID=
set PROFILE=mcp-chatgpt-full-pc-dev
set CONFIG_DIR=%APPDATA%\tunnel-client
set CONFIG_FILE=%CONFIG_DIR%\%PROFILE%.yaml

echo.
echo Configuracao do profile do OpenAI Tunnel para este PC
echo Profile: %PROFILE%
echo.
set /p TUNNEL_ID=Tunnel ID [%DEFAULT_TUNNEL_ID%]: 
if "%TUNNEL_ID%"=="" set TUNNEL_ID=%DEFAULT_TUNNEL_ID%

if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

for %%I in ("C:\Program Files\nodejs\node.exe") do set NODE_SHORT=%%~sI
for %%I in ("%~dp0src\app.mjs") do set APP_SHORT=%%~sI

set NODE_CMD=!NODE_SHORT:\=/!
set APP_CMD=!APP_SHORT:\=/!
if not exist "!NODE_SHORT!" (
  echo ERRO: Node.js nao encontrado em C:\Program Files\nodejs\node.exe
  echo Instale o Node.js LTS e rode este script novamente.
  pause
  exit /b 1
)

if not exist "!APP_SHORT!" (
  echo ERRO: app.mjs nao encontrado em %~dp0src\app.mjs
  pause
  exit /b 1
)

> "%CONFIG_FILE%" echo config_version: 1
>> "%CONFIG_FILE%" echo control_plane:
>> "%CONFIG_FILE%" echo   base_url: "https://api.openai.com"
>> "%CONFIG_FILE%" echo.
>> "%CONFIG_FILE%" echo   tunnel_id: "%TUNNEL_ID%"
>> "%CONFIG_FILE%" echo   api_key: "env:CONTROL_PLANE_API_KEY"
>> "%CONFIG_FILE%" echo health:
>> "%CONFIG_FILE%" echo   listen_addr: "127.0.0.1:8080"
>> "%CONFIG_FILE%" echo admin_ui:
>> "%CONFIG_FILE%" echo   open_browser: false
>> "%CONFIG_FILE%" echo log:
>> "%CONFIG_FILE%" echo   level: info
>> "%CONFIG_FILE%" echo   format: json
>> "%CONFIG_FILE%" echo mcp:
>> "%CONFIG_FILE%" echo   commands:
>> "%CONFIG_FILE%" echo     - channel: main
>> "%CONFIG_FILE%" echo       command: "!NODE_CMD! !APP_CMD!"

echo.
echo Profile gerado em:
echo %CONFIG_FILE%
echo.
echo Comando MCP final:
echo !NODE_CMD! !APP_CMD!
echo.
echo Proximo passo: rode tunnel-doctor.cmd e depois tunnel-run.cmd.
pause
