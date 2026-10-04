@echo off
setlocal
cd /d "%~dp0"
set "LIFEOPS_PORT="
set "LIFEOPS_READY="
set "LIFEOPS_NODE=node"

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 set "LIFEOPS_NODE="
if not defined LIFEOPS_NODE call :bootstrap_node
if not defined LIFEOPS_NODE goto node_setup_failed
"%LIFEOPS_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto node_setup_failed

if not exist ".env" (
  if not exist ".env.example" goto no_env_template
  copy /Y ".env.example" ".env" >nul
  if errorlevel 1 goto env_setup_failed
  echo Created .env from the safe template. Optional provider keys can be added later.
)

for /L %%P in (4173,1,4190) do if not defined LIFEOPS_PORT call :probe_running_port %%P
if defined LIFEOPS_PORT goto already_running

set "LIFEOPS_PORT_FILE=%TEMP%\lifeops-port-%RANDOM%-%RANDOM%.txt"
"%LIFEOPS_NODE%" -e "const net=require('net');let p=4173;const probe=()=>{if(p>4190)process.exit(1);const s=net.createServer();s.once('error',()=>{p++;probe()});s.listen(p,'127.0.0.1',()=>s.close(()=>console.log(p)))};probe()" > "%LIFEOPS_PORT_FILE%"
if errorlevel 1 goto no_port
if exist "%LIFEOPS_PORT_FILE%" set /p "LIFEOPS_PORT="<"%LIFEOPS_PORT_FILE%"
if exist "%LIFEOPS_PORT_FILE%" del "%LIFEOPS_PORT_FILE%" >nul 2>&1
if not defined LIFEOPS_PORT goto no_port
set "PORT=%LIFEOPS_PORT%"

echo Starting LifeOps...
start "" /B "%LIFEOPS_NODE%" server.js

for /L %%I in (1,1,20) do (
  if not defined LIFEOPS_READY (
    "%LIFEOPS_NODE%" -e "fetch('http://127.0.0.1:%LIFEOPS_PORT%/api/config').then(r=>r.json()).then(c=>process.exit(c.build==='lifeops-workspace-v1'?0:1)).catch(()=>process.exit(1))" >nul 2>&1
    if not errorlevel 1 set "LIFEOPS_READY=1"
    if not defined LIFEOPS_READY ping -n 2 127.0.0.1 >nul
  )
)
if not defined LIFEOPS_READY goto no_response
goto open_app

:already_running
echo LifeOps is already running. Opening its workspace...
goto monitor_browser

:open_app
echo LifeOps is ready.
goto monitor_browser

:monitor_browser
start "" "http://localhost:%LIFEOPS_PORT%/#product"
echo LifeOps is running. This window will close when you close the last LifeOps tab.
"%LIFEOPS_NODE%" -e "const u='http://127.0.0.1:%LIFEOPS_PORT%/api/config';const wait=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{for(;;){try{await fetch(u);await wait(500)}catch{break}}})()"
exit /b 0

:probe_running_port
"%LIFEOPS_NODE%" -e "fetch('http://127.0.0.1:%1/api/config',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(c=>process.exit(c.build==='lifeops-workspace-v1'?0:1)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 set "LIFEOPS_PORT=%1"
exit /b 0

:bootstrap_node
echo Checking for a compatible Node.js runtime...
set "LIFEOPS_NODE_FILE=%TEMP%\lifeops-node-%RANDOM%-%RANDOM%.txt"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1" > "%LIFEOPS_NODE_FILE%"
if errorlevel 1 exit /b 1
if exist "%LIFEOPS_NODE_FILE%" set /p "LIFEOPS_NODE="<"%LIFEOPS_NODE_FILE%"
if exist "%LIFEOPS_NODE_FILE%" del "%LIFEOPS_NODE_FILE%" >nul 2>&1
exit /b 0

:no_response
echo.
echo LifeOps did not respond at http://localhost:%LIFEOPS_PORT%.
echo Check the messages above for a server error.
pause
exit /b 1

:no_env_template
echo The .env.example setup template is missing.
echo Re-download or restore the complete LifeOps project folder.
pause
exit /b 1

:env_setup_failed
echo Could not create .env from .env.example.
echo Check that this folder is writable, then try again.
pause
exit /b 1

:no_port
echo LifeOps could not find an available local port between 4173 and 4190.
echo Close another local service or LifeOps server, then try again.
pause
exit /b 1

:node_setup_failed
echo LifeOps could not find or install Node.js 18 or later.
echo Check your internet connection, then try again, or install Node.js from https://nodejs.org/.
pause
exit /b 1
