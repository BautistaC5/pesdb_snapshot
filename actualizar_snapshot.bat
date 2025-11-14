@echo off
title Refrescando PESDB Snapshot
echo Iniciando servidor temporal...
start cmd /k "npm start"
timeout /t 5 >nul
echo Actualizando snapshot (esto puede tardar varios minutos)...
start "" http://localhost:3000/refresh
pause
