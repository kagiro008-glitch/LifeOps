@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto no_node

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto old_node

node -e "fetch('http://127.0.0.1:4173/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto already_running

echo Starting LifeOps...
start "" /B node server.js

for /L %%I in (1,1,20) do (
  node -e "fetch('http://127.0.0.1:4173/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
  if not errorlevel 1 goto open_app
  ping -n 2 127.0.0.1 >nul
)

echo.
echo LifeOps did not respond at http://localhost:4173.
echo Check the messages above for a server error.
pause
exit /b 1

:already_running
echo LifeOps is already running. Opening the existing local app...
goto open_existing_app

:open_app
echo LifeOps is ready.
goto launch_browser

:open_existing_app
start "" "http://localhost:4173/"
exit /b 0

:launch_browser
start "" "http://localhost:4173/"
echo LifeOps is running. Close the last LifeOps browser tab to stop the server and close this window.
node -e "const u='http://127.0.0.1:4173/api/config';const wait=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{for(;;){try{await fetch(u);await wait(500)}catch{break}}})()"
exit /b 0

:no_node
echo Node.js is required but was not found.
echo Install Node.js 18 or later, then double-click this file again.
pause
exit /b 1

:old_node
echo LifeOps requires Node.js 18 or later.
node --version
pause
exit /b 1
