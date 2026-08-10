# Sobe o Jarvis e a antena, se ja nao estiverem no ar.
#
# E seguro rodar quantas vezes quiser: antes de iniciar qualquer coisa ele
# checa se a porta ja esta ocupada. Por isso da pra agendar de 30 em 30 min
# como rede de seguranca — se um dos dois cair durante o dia, o proximo
# ciclo levanta de novo sozinho.
#
# Uso manual:  powershell -ExecutionPolicy Bypass -File iniciar-jarvis.ps1
# Agendar:     powershell -ExecutionPolicy Bypass -File iniciar-jarvis.ps1 -Agendar

param([switch]$Agendar, [switch]$Parar, [switch]$Status)

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$TAREFA = "JarvisSempreDePe"

function Porta-Ocupada($porta) {
  $c = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

# ---------- parar ----------
if ($Parar) {
  foreach ($p in 8899, 4242) {
    $con = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $con) {
      try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Write-Output "porta $p encerrada" } catch {}
    }
  }
  Write-Output "Jarvis parado. (o agendamento continua; use -Parar de novo quando quiser)"
  exit
}

# ---------- status ----------
if ($Status) {
  Write-Output ("Jarvis (8899) : " + $(if (Porta-Ocupada 8899) { "no ar" } else { "parado" }))
  Write-Output ("Antena (4242) : " + $(if (Porta-Ocupada 4242) { "no ar" } else { "parado" }))
  $t = Get-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue
  Write-Output ("Sobe sozinho  : " + $(if ($t) { "sim (" + $t.State + ")" } else { "nao agendado" }))
  exit
}

# ---------- agendar pra subir sozinho ----------
if ($Agendar) {
  # schtasks em vez de Register-ScheduledTask: o cmdlet exige elevacao
  # ("Acesso negado" sem admin), enquanto o schtasks cria tarefa do proprio
  # usuario numa boa. /ri 30 repete de meia em meia hora como rede de
  # seguranca — o script e idempotente, entao repetir nao duplica nada.
  # Aponta pro .cmd irmao: passar "powershell -ExecutionPolicy ..." direto faz
  # o PowerShell tratar os "-" como parametros DELE e o schtasks recebe lixo.
  $alvo = Join-Path $base "iniciar-jarvis.cmd"
  $saida = cmd /c "schtasks /create /tn $TAREFA /tr `"$alvo`" /sc onlogon /f" 2>&1
  $criou = $LASTEXITCODE -eq 0

  if ($criou) {
    # repeticao de 30 min como rede de seguranca, se o Windows aceitar
    cmd /c "schtasks /change /tn $TAREFA /ri 30 /du 9999:59" 2>&1 | Out-Null
  } else {
    # plano B: so o ciclo de 30 min (cobre o login com ate 30 min de atraso)
    $saida = cmd /c "schtasks /create /tn $TAREFA /tr `"$alvo`" /sc minute /mo 30 /f" 2>&1
    $criou = $LASTEXITCODE -eq 0
  }

  if ($criou) {
    # roda mesmo se o PC estiver desligado na hora prevista
    try {
      $t = Get-ScheduledTask -TaskName $TAREFA
      $t.Settings.StartWhenAvailable = $true
      Set-ScheduledTask -TaskName $TAREFA -Settings $t.Settings | Out-Null
    } catch {}
    Write-Output "Agendado: o Jarvis sobe sozinho e se recupera a cada 30 min."
    Write-Output "  ver status : .\iniciar-jarvis.ps1 -Status"
    Write-Output "  parar agora: .\iniciar-jarvis.ps1 -Parar"
    Write-Output "  desagendar : schtasks /delete /tn $TAREFA /f"
  } else {
    # NAO mentir dizendo que deu certo quando nao deu
    Write-Output "FALHOU ao agendar. Resposta do Windows:"
    Write-Output ("  " + ($saida -join " "))
    Write-Output "Os servidores vao subir agora mesmo assim, mas nao sozinhos no proximo login."
  }
  # segue adiante e ja sobe agora
}

# ---------- subir o que estiver faltando ----------
if (Porta-Ocupada 8899) {
  Write-Output "Jarvis (8899) ja estava no ar."
} else {
  Start-Process -FilePath "python" -ArgumentList "-m", "http.server", "8899" `
    -WorkingDirectory $base -WindowStyle Hidden
  Write-Output "Jarvis (8899) iniciado."
}

if (Porta-Ocupada 4242) {
  Write-Output "Antena (4242) ja estava no ar."
} else {
  Start-Process -FilePath "node" -ArgumentList "server.js" `
    -WorkingDirectory $base -WindowStyle Hidden
  Write-Output "Antena (4242) iniciada."
}

Start-Sleep -Seconds 2
Write-Output ""
Write-Output "Abra: http://localhost:8899/jarvis.html"
