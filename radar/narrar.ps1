# Radar de Noticias - narrador
# Transforma o roteiro do dia em audio usando a voz do proprio Windows (SAPI).
# Nao usa nenhum servico online, nenhuma chave, e funciona offline.
#
# PRA MUDAR A VOZ OU A VELOCIDADE: mexa no config.json (bloco "voz"),
# nao aqui. Veja as vozes disponiveis com: radar vozes

param(
  [string]$Pasta = "",   # pasta do boletim; vazio = o mais recente
  [switch]$Playlist      # gera tambem um arquivo por noticia
)

$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path

$cfg = Get-Content (Join-Path $base "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$vozNome = $cfg.voz.nome
$rate    = [int]$cfg.voz.rate

if ([string]::IsNullOrWhiteSpace($Pasta)) {
  $ultima = Get-ChildItem (Join-Path $base "boletins") -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
  if (-not $ultima) { Write-Output "Nenhum boletim encontrado. Rode 'radar' primeiro."; exit 1 }
  $Pasta = $ultima.FullName
}

$roteiro = Join-Path $Pasta "roteiro-audio.txt"
if (-not (Test-Path $roteiro)) { Write-Output "Nao achei roteiro-audio.txt em $Pasta"; exit 1 }

$texto = Get-Content $roteiro -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($texto)) { Write-Output "Roteiro vazio."; exit 1 }

$saidaWav = Join-Path $Pasta "boletim.wav"
$motor = if ($cfg.voz.motor) { $cfg.voz.motor } else { "auto" }

# ---------------------------------------------------------------------------
# Ordem das vozes, da melhor pra mais simples: Kokoro > Piper > voz do Windows.
# Cada uma so entra se a anterior nao existir ou falhar - o boletim nunca fica
# sem audio por causa de motor de voz.
# ---------------------------------------------------------------------------
$usouKokoro = $false
$usouPiper  = $false

# ---- Kokoro: modelo neural de 82M, roda local e offline (Apache 2.0) ----
$kokoroPy  = Join-Path $base "kokoro\venv\Scripts\python.exe"
$kokoroApp = Join-Path $base "kokoro\falar.py"

if ($motor -ne "sapi" -and $motor -ne "piper" -and (Test-Path $kokoroPy) -and (Test-Path $kokoroApp)) {
  $vozK = if ($cfg.voz.kokoro_voz) { $cfg.voz.kokoro_voz } else { "pf_dora" }
  $velK = if ($cfg.voz.kokoro_velocidade) { [double]$cfg.voz.kokoro_velocidade } else { 1.0 }
  $tmpK = Join-Path $Pasta "_roteiro_utf8.txt"
  [System.IO.File]::WriteAllText($tmpK, $texto, (New-Object System.Text.UTF8Encoding($false)))

  # Mesmo cuidado do Piper: bibliotecas de ML escrevem aviso no stderr mesmo
  # quando da tudo certo. Julgamos pelo ARQUIVO gerado, nao pelo stderr.
  # A saida vai pro log em vez de /dev/null: jogar fora torna impossivel
  # descobrir POR QUE o Kokoro falhou quando ele falha.
  $logK = Join-Path $base "logs\kokoro.log"
  New-Item -ItemType Directory -Force (Split-Path $logK) | Out-Null
  $antesK = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $kokoroPy $kokoroApp $tmpK $saidaWav $vozK $velK *>&1 |
    ForEach-Object { "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $_ } |
    Out-File -FilePath $logK -Append -Encoding UTF8
  $codigoK = $LASTEXITCODE
  $ErrorActionPreference = $antesK

  Remove-Item $tmpK -ErrorAction SilentlyContinue
  if ((Test-Path $saidaWav) -and (Get-Item $saidaWav).Length -gt 10KB) {
    $usouKokoro = $true
    Write-Output "Voz: Kokoro $vozK (neural 82M, offline)"
  } else {
    Write-Output "Kokoro nao gerou audio (codigo $codigoK); tentando o Piper. Detalhe em logs\kokoro.log"
  }
}

# ---- Piper: voz neural, offline e gratuita. Bem melhor que a do Windows. ----
$piperExe = Join-Path $base "piper\piper\piper.exe"
$piperVoz = Join-Path $base ("piper\" + $(if ($cfg.voz.piper_modelo) { $cfg.voz.piper_modelo } else { "pt_BR-faber-medium.onnx" }))

if (-not $usouKokoro -and $motor -ne "sapi" -and (Test-Path $piperExe) -and (Test-Path $piperVoz)) {
  $ls = if ($cfg.voz.piper_length_scale) { [double]$cfg.voz.piper_length_scale } else { 1.0 }
  # o texto vai por arquivo temporario em UTF-8: passar acento por pipe do
  # PowerShell pra .exe costuma corromper caractere
  $tmp = Join-Path $Pasta "_roteiro_utf8.txt"
  [System.IO.File]::WriteAllText($tmp, $texto, (New-Object System.Text.UTF8Encoding($false)))

  # ATENCAO: o Piper escreve o log dele no stderr mesmo quando da tudo certo.
  # Com $ErrorActionPreference = "Stop", isso viraria "erro" e derrubaria a
  # execucao. Por isso soltamos o modo Stop so aqui e conferimos o RESULTADO
  # (o arquivo existe e tem tamanho?) em vez de confiar no stderr.
  $antes = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  cmd /c "type `"$tmp`" | `"$piperExe`" -m `"$piperVoz`" -f `"$saidaWav`" --length_scale $ls 2>nul"
  $ErrorActionPreference = $antes

  Remove-Item $tmp -ErrorAction SilentlyContinue
  if ((Test-Path $saidaWav) -and (Get-Item $saidaWav).Length -gt 10KB) {
    $usouPiper = $true
    Write-Output "Voz: Piper $(Split-Path $piperVoz -Leaf) (neural, offline)"
  } else {
    Write-Output "Piper nao gerou audio; caindo pra voz do Windows."
  }
}

# ---- SAPI (voz do Windows): ultimo recurso, so se as duas anteriores falharem ----
Add-Type -AssemblyName System.Speech
$sint = New-Object System.Speech.Synthesis.SpeechSynthesizer

# Tem que checar as DUAS: olhando so o Piper, um Kokoro bem-sucedido cairia
# aqui do mesmo jeito e o SAPI sobrescreveria o audio bom.
if (-not $usouKokoro -and -not $usouPiper) {
  $vozes = $sint.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
  $alvo = $vozes | Where-Object { $_.Name -eq $vozNome } | Select-Object -First 1
  if (-not $alvo) { $alvo = $vozes | Where-Object { $_.Culture -like "pt*" } | Select-Object -First 1 }
  if ($alvo) {
    $sint.SelectVoice($alvo.Name)
    Write-Output "Voz: $($alvo.Name) [$($alvo.Culture)] (Windows)"
  } else {
    Write-Output "AVISO: nenhuma voz pt-BR instalada; usando a voz padrao do Windows."
  }
  $sint.Rate = $rate
  $sint.SetOutputToWaveFile($saidaWav)
  $sint.Speak($texto)
  $sint.SetOutputToNull()
}

# se o ffmpeg existir, gera .m4a (bem menor). Senao, o .wav ja toca em tudo.
$final = $saidaWav
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  $m4a = Join-Path $Pasta "boletim.m4a"
  & ffmpeg -y -loglevel error -i $saidaWav -c:a aac -b:a 96k $m4a
  if (Test-Path $m4a) { $final = $m4a; Remove-Item $saidaWav -ErrorAction SilentlyContinue }
}

# playlist opcional: um arquivo por noticia
if ($Playlist) {
  $blocos = ($texto -split "(?m)^\s*(Vamos comecar\.|Proxima\.|Pra fechar\.)\s*$") |
            Where-Object { $_.Trim().Length -gt 40 }
  $i = 0
  foreach ($b in $blocos) {
    $i++
    $arq = Join-Path $Pasta ("faixa-{0:d2}.wav" -f $i)
    $sint.SetOutputToWaveFile($arq); $sint.Speak($b); $sint.SetOutputToNull()
  }
  Write-Output "Playlist: $i faixa(s)."
}

$sint.Dispose()

# duracao real do arquivo, pra conferir se bateu o alvo
$dur = $null
try {
  $sh = New-Object -ComObject Shell.Application
  $p = $sh.Namespace((Split-Path $final)); $it = $p.ParseName((Split-Path $final -Leaf))
  $dur = $p.GetDetailsOf($it, 27)
} catch {}

$kb = [math]::Round((Get-Item $final).Length / 1KB)
if ($dur) { Write-Output "Audio pronto: $final ($dur, $kb KB)" }
else       { Write-Output "Audio pronto: $final ($kb KB)" }

# Avisa o Jarvis o caminho do audio. Isso tem que ser AQUI, e nao no coletar.py:
# quando o coletor termina o audio ainda nao existe, entao o campo sairia vazio.
foreach ($j in @("D:\8 - Claude - projeto\Jarvis", "D:\Claude - projeto\Jarvis", "$env:USERPROFILE\Jarvis")) {
  $bol = Join-Path $j "agent-state\radar-boletim.json"
  if (Test-Path $bol) {
    try {
      $o = Get-Content $bol -Raw -Encoding UTF8 | ConvertFrom-Json
      $o.audio = $final
      if ($dur) { $o | Add-Member -NotePropertyName duracao -NotePropertyValue $dur -Force }
      # UTF-8 SEM BOM. O Set-Content -Encoding UTF8 do PS 5.1 cola EF BB BF no
      # inicio e qualquer leitor com JSON.parse cru ou json.load do Python
      # quebra ao abrir este arquivo - que e justamente o que o Jarvis le.
      $texto = $o | ConvertTo-Json -Depth 6
      [System.IO.File]::WriteAllText($bol, $texto, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output "Jarvis avisado: $bol"
    } catch { }
    break
  }
}
