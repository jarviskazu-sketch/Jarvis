@echo off
REM Envelope pro analista (camada 3). Existe por causa das aspas:
REM o caminho tem espacos ("8 - Claude - projeto") e passar isso direto no
REM /tr do schtasks quebra na primeira lacuna -- foi assim que o Radar
REM ficou 7 dias morto. Com o .cmd, a tarefa agendada precisa citar UM
REM caminho so, e o resto fica resolvido aqui dentro.
cd /d "%~dp0"
python analista.py
