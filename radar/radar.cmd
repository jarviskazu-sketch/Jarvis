@echo off
REM Atalho pra chamar o radar de qualquer lugar: basta digitar "radar"
powershell -ExecutionPolicy Bypass -File "%~dp0radar.ps1" %*
