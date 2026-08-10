@echo off
REM Atalho pro agendador chamar. Existe pra evitar aspas aninhadas no schtasks.
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0iniciar-jarvis.ps1"
