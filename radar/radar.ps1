# Radar de Noticias - menu de comandos
# Uso: radar [comando] [argumento]
# Rode "radar ajuda" pra ver tudo.

# Tudo entra por UM parametro so, e o comando sai da primeira posicao.
# Motivo: com um [string]$cmd declarado, o PowerShell tentava casar "-fonte"
# como NOME de parametro. Nao existindo parametro com esse nome, ele ia parar
# no resto e o $cmd ficava vazio - ou seja, "radar -fonte InfoMoney" rodava o
# radar inteiro em vez de desativar a fonte. Sem parametro nomeado nenhum,
# o "-fonte" chega como texto comum, que e o que a gente quer.
param(
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$todos
)

$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = "python"
$cmd = if ($todos -and $todos.Count -ge 1) { $todos[0] } else { "" }
$arg = if ($todos -and $todos.Count -ge 2) { ($todos[1..($todos.Count - 1)] -join " ").Trim() } else { "" }

function Pasta-Ultima {
  Get-ChildItem (Join-Path $base "boletins") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
}
function Ler-Fontes { Get-Content (Join-Path $base "fontes.json") -Raw -Encoding UTF8 | ConvertFrom-Json }

# NAO troque isto por Set-Content -Encoding UTF8.
# O "UTF8" do PowerShell 5.1 grava BOM (os bytes EF BB BF) no comeco do arquivo,
# e o json.load do Python quebra na hora: "Unexpected UTF-8 BOM".
# Na pratica: bastava rodar 'radar +fonte' ou 'radar nicho' uma vez para o
# coletar.py parar de abrir o fontes.json / config.json na execucao seguinte.
# A API .NET com UTF8Encoding($false) grava UTF-8 limpo, sem BOM.
function Salvar-Json($obj, $caminho) {
  $texto = $obj | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($caminho, $texto, (New-Object System.Text.UTF8Encoding($false)))
}
function Salvar-Fontes($obj) {
  Salvar-Json $obj (Join-Path $base "fontes.json")
}
# Perguntar "sobrescrever?" so faz sentido quando tem gente pra responder.
#
# NAO TENTE DETECTAR ISSO PELO AMBIENTE. Foi medido: rodando pelo Agendador,
# [Environment]::UserInteractive da True, [Console]::WindowHeight devolve 49
# (existe console de verdade) e IsInputRedirected da False. Nenhuma sonda
# separa "tem gente olhando" de "e a rodada das 07:00" - e um Read-Host la
# fica pendurado pra sempre, justamente no modo em que ninguem percebe.
#
# Entao o contrato e o VERBO, que e deterministico:
#   radar        -> voce digitou, pergunta antes de sobrescrever
#   radar tudo   -> modo agendado, refaz sem perguntar
$modoAgendado = ($cmd -eq "tudo")

function Confirma-Sobrescrever {
  if ($modoAgendado) { return $true }
  $r = Read-Host "Ja existe boletim de hoje. Sobrescrever? (s/N)"
  return ($r -eq "s")
}

function Notificar($titulo, $msg) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.BalloonTipTitle = $titulo; $n.BalloonTipText = $msg
    $n.Visible = $true; $n.ShowBalloonTip(6000)
    Start-Sleep -Seconds 7; $n.Dispose()
  } catch {}
}

switch ($cmd) {

  # ---------- roda tudo: coleta + boletim + audio + notificacao ----------
  { $_ -in "", "tudo", "run" } {
    $hoje = Get-Date -Format "yyyy-MM-dd"
    $pastaHoje = Join-Path $base "boletins\$hoje"
    if (Test-Path (Join-Path $pastaHoje "boletim.md")) {
      if (-not (Confirma-Sobrescrever)) { Write-Output "Cancelado."; break }
    }
    Write-Output "== Coletando =="
    $saida = & $py (Join-Path $base "coletar.py")
    $saida | Select-Object -Last 1 | Out-Null
    $json = $saida | Where-Object { $_ -like "{*" } | Select-Object -Last 1
    Write-Output "== Narrando =="
    & powershell -ExecutionPolicy Bypass -File (Join-Path $base "narrar.ps1")
    if ($json) {
      $o = $json | ConvertFrom-Json
      Notificar "Radar pronto" "$($o.selecionados) noticias de $($o.vistos) itens varridos."
      Write-Output ""
      Write-Output ">> Boletim: $($o.pasta)"
    }
  }

  "texto" {
    # A mesma guarda do 'radar' completo tem que valer aqui. Sem ela, um
    # 'radar texto' rodado no fim do dia reescrevia o boletim.md por cima -
    # e como a deduplicacao ja tinha guardado as noticias da manha, o texto
    # novo vinha com as sobras do dia e ficava DIFERENTE do audio ja gravado.
    $hoje = Get-Date -Format "yyyy-MM-dd"
    if (Test-Path (Join-Path $base "boletins\$hoje\boletim.md")) {
      if (-not (Confirma-Sobrescrever)) { Write-Output "Cancelado."; break }
    }
    Write-Output "== So o boletim escrito =="
    & $py (Join-Path $base "coletar.py")
  }

  "voz" {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $base "narrar.ps1")
  }

  # ouve uma frase curta pra comparar as vozes sem gerar boletim inteiro
  "testarvoz" {
    $kpy = Join-Path $base "kokoro\venv\Scripts\python.exe"
    $kap = Join-Path $base "kokoro\falar.py"
    if (-not (Test-Path $kpy)) { Write-Output "Kokoro nao esta instalado."; break }
    $voz = if ($arg) { $arg } else {
      (Get-Content (Join-Path $base "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json).voz.kokoro_voz }
    $txt = Join-Path $env:TEMP "_radar_teste_voz.txt"
    $wav = Join-Path $base "teste-voz.wav"
    [System.IO.File]::WriteAllText($txt,
      "Bom dia. Aqui e o seu radar de energia e seguros. A tarifa subiu sete virgula seis por cento no Para.",
      (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Gerando com a voz $voz ..."
    $antes = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $kpy $kap $txt $wav $voz 1.0
    $ErrorActionPreference = $antes
    Remove-Item $txt -ErrorAction SilentlyContinue
    if (Test-Path $wav) {
      Write-Output "Pronto: $wav"
      Start-Process $wav
    } else { Write-Output "Nao gerou audio." }
  }

  "vozes" {
    $ordem = @()
    if (Test-Path (Join-Path $base "kokoro\venv\Scripts\python.exe")) { $ordem += "Kokoro" }
    if (Test-Path (Join-Path $base "piper\piper\piper.exe"))          { $ordem += "Piper" }
    $ordem += "Windows"
    Write-Output ""
    Write-Output ("Ordem de preferencia (o radar usa a primeira que funcionar): " + ($ordem -join " > "))

    if (Test-Path (Join-Path $base "kokoro\venv\Scripts\python.exe")) {
      Write-Output ""
      Write-Output "KOKORO (neural 82M, offline) - melhor qualidade"
      Write-Output "  pf_dora     feminina pt-BR"
      Write-Output "  pm_alex     masculina pt-BR"
      Write-Output "  pm_santa    masculina pt-BR"
      Write-Output "  Pra trocar: 'voz.kokoro_voz' no config.json"
    }
    if (Test-Path (Join-Path $base "piper\piper\piper.exe")) {
      Write-Output ""
      Write-Output "PIPER (neural, offline)"
      Get-ChildItem (Join-Path $base "piper") -Filter "*.onnx" -ErrorAction SilentlyContinue |
        ForEach-Object { "  " + $_.BaseName }
      Write-Output "  Pra trocar: 'voz.piper_modelo' no config.json"
    }
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    Write-Output ""
    Write-Output "WINDOWS (SAPI) - sempre disponivel"
    $s.GetInstalledVoices() | ForEach-Object {
      $i = $_.VoiceInfo; "  {0,-32} {1,-8} {2}" -f $i.Name, $i.Culture, $i.Gender }
    Write-Output "  Pra trocar: 'voz.nome' no config.json"
    Write-Output ""
    Write-Output "Pra forcar um motor especifico: 'voz.motor' = kokoro | piper | sapi | auto"
  }

  # ---------- fontes ----------
  "fontes" {
    $f = Ler-Fontes
    Write-Output ""
    "{0,-30} {1,-14} {2,-5} {3}" -f "FONTE","TIPO","NOTA","STATUS"
    "-" * 72
    foreach ($x in $f.fontes) {
      $st = if ($x.ativo) { "ativa" } else { "desativada" }
      "{0,-30} {1,-14} {2,-5} {3}" -f $x.nome, $x.tipo, $x.nota, $st
    }
    if ($f._rejeitadas) {
      Write-Output ""
      Write-Output "Rejeitadas na curadoria:"
      foreach ($r in $f._rejeitadas) { "  - {0}: {1}" -f $r.nome, $r.motivo }
    }
  }

  "+fonte" {
    if (-not $arg) { Write-Output "Uso: radar +fonte <url do site ou do feed>"; break }
    Write-Output "Procurando o feed em $arg ..."
    $d = & $py (Join-Path $base "coletar.py") descobrir $arg | ConvertFrom-Json
    if (-not $d.feed) { Write-Output "Nao achei feed: $($d.como)"; break }
    Write-Output "Feed encontrado ($($d.como)): $($d.feed)"
    $v = & $py (Join-Path $base "coletar.py") validar $d.feed | ConvertFrom-Json
    if (-not $v.ok) { Write-Output "REPROVADO na validacao: $($v.motivo)"; break }
    Write-Output "Validado: $($v.itens) itens, ultimo ha $($v.idade_dias) dia(s)."
    Write-Output "Exemplos: $($v.titulos -join ' | ')"
    $nome = Read-Host "Nome curto pra essa fonte"
    $tipo = Read-Host "Tipo (oficial/especializada/generalista/comunidade/contraponto)"
    $nota = Read-Host "Nota de 0 a 10"
    $f = Ler-Fontes
    $f.fontes += [pscustomobject]@{
      nome=$nome; tipo=$tipo; feed=$d.feed; idioma="pt-BR"
      nota=[int]$nota; ativo=$true; porque="adicionada manualmente"
    }
    Salvar-Fontes $f
    Write-Output "Adicionada. Total: $($f.fontes.Count) fontes."
  }

  "-fonte" {
    if (-not $arg) { Write-Output "Uso: radar -fonte <nome>"; break }
    $f = Ler-Fontes
    $achou = $false
    foreach ($x in $f.fontes) { if ($x.nome -like "*$arg*") { $x.ativo = $false; $achou = $true; Write-Output "Desativada: $($x.nome)" } }
    if ($achou) { Salvar-Fontes $f; Write-Output "(o historico dela foi mantido)" } else { Write-Output "Nao achei fonte com esse nome." }
  }

  "nicho" {
    $cfgPath = Join-Path $base "config.json"
    $c = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $arg) { Write-Output "Nicho atual: $($c.nicho)"; Write-Output "Palavras-chave: $($c.palavras_chave -join ', ')"; break }
    $c.nicho = $arg
    Salvar-Json $c $cfgPath
    Write-Output "Nicho atualizado para: $arg"
    Write-Output "Dica: ajuste tambem 'palavras_chave' no config.json - e o que mais pesa no ranking."
  }

  "busca" {
    if (-not $arg) { Write-Output "Uso: radar busca <tema>"; break }
    $q = [uri]::EscapeDataString($arg)
    $url = "https://news.google.com/rss/search?q=$q+when:7d&hl=pt-BR&gl=BR&ceid=BR:pt-419"
    $v = & $py (Join-Path $base "coletar.py") validar $url | ConvertFrom-Json
    if ($v.ok) {
      Write-Output "Resultados para '$arg' (ultimos 7 dias):"
      $v.titulos | ForEach-Object { "  - $_" }
      Write-Output "  ... $($v.itens) resultados no total."
    } else { Write-Output "Sem resultados: $($v.motivo)" }
  }

  # ---------- pauta e clipping ----------
  "clipping" { & $py (Join-Path $base "pauta.py") clipping }
  "ganchos"  { & $py (Join-Path $base "pauta.py") ganchos }

  "opml" {
    $o = Join-Path $base "fontes.opml"
    if (-not (Test-Path $o)) { Write-Output "fontes.opml nao existe. Rode 'radar fontes' primeiro."; break }
    Write-Output ""
    Write-Output "Arquivo: $o"
    Write-Output ""
    Write-Output "Pra ler as mesmas fontes no celular, sem depender do PC ligado:"
    Write-Output "  1. mande esse arquivo pra voce (WhatsApp, Drive, e-mail...)"
    Write-Output "  2. instale um leitor de RSS gratuito:"
    Write-Output "       Android : Feeder (open source) ou Inoreader"
    Write-Output "       iPhone  : NetNewsWire (open source) ou Feedly"
    Write-Output "  3. no app, procure 'Importar OPML' e escolha o arquivo"
    Write-Output ""
    Write-Output "As 11 fontes entram de uma vez. O radar continua fazendo a curadoria"
    Write-Output "no PC; o app do celular e so pra ler cru quando a maquina estiver off."
    explorer.exe "/select,`"$o`""
  }

  "semana" {
    $db = Join-Path $base "historico.sqlite"
    if (-not (Test-Path $db)) { Write-Output "Ainda nao ha historico."; break }
    & $py -c @"
import sqlite3, sys, io
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from datetime import datetime, timedelta
c = sqlite3.connect(r'$db')
lim = (datetime.now()-timedelta(days=7)).isoformat()
r = c.execute('SELECT veiculo, COUNT(*) FROM itens WHERE data_coleta>? GROUP BY veiculo ORDER BY 2 DESC', (lim,)).fetchall()
t = c.execute('SELECT COUNT(*) FROM itens WHERE data_coleta>?', (lim,)).fetchone()[0]
u = c.execute('SELECT COUNT(*) FROM itens WHERE data_coleta>? AND usado=1', (lim,)).fetchone()[0]
print(f'\nUltimos 7 dias: {t} itens coletados, {u} entraram em boletim\n')
for v, n in r: print(f'  {v:32} {n}')
print('\nDestaques (maior score):')
for ti, ve, sc in c.execute('SELECT titulo, veiculo, score FROM itens WHERE data_coleta>? AND usado=1 ORDER BY score DESC LIMIT 5', (lim,)):
    print(f'  [{sc}] {ti[:66]} - {ve}')
"@
  }

  "arquivo" {
    if (-not $arg) { Write-Output "Uso: radar arquivo <termo>"; break }
    $db = Join-Path $base "historico.sqlite"
    if (-not (Test-Path $db)) { Write-Output "Ainda nao ha historico."; break }
    & $py -c @"
import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
c = sqlite3.connect(r'$db')
q = '%$arg%'
r = c.execute('SELECT data_pub, veiculo, titulo, link FROM itens WHERE titulo LIKE ? ORDER BY data_pub DESC LIMIT 25', (q,)).fetchall()
print(f'\n{len(r)} resultado(s) para \"$arg\":\n')
for d, v, t, l in r:
    print(f'  {d[:10]} | {v[:20]:20} | {t[:60]}')
    print(f'           {l}')
"@
  }

  "status" {
    $u = Pasta-Ultima
    Write-Output ""
    if ($u) {
      Write-Output "Ultimo boletim : $($u.Name)"
      $md = Join-Path $u.FullName "boletim.md"
      $wav = Get-ChildItem $u.FullName -Filter "boletim.*" -ErrorAction SilentlyContinue |
             Where-Object { $_.Extension -in ".wav",".m4a" } | Select-Object -First 1
      Write-Output "Texto          : $(if (Test-Path $md) {'ok'} else {'FALTANDO'})"
      Write-Output "Audio          : $(if ($wav) {"$($wav.Name) ($([math]::Round($wav.Length/1KB)) KB)"} else {'FALTANDO'})"
    } else { Write-Output "Nenhum boletim gerado ainda." }
    $f = Ler-Fontes
    Write-Output "Fontes ativas  : $(($f.fontes | Where-Object {$_.ativo}).Count) de $($f.fontes.Count)"
    $log = Get-ChildItem (Join-Path $base "logs") -Filter "*.log" -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending | Select-Object -First 1
    if ($log) {
      $falhas = Select-String -Path $log.FullName -Pattern "FALHOU" -ErrorAction SilentlyContinue
      Write-Output "Ultimo log     : $($log.Name)"
      Write-Output "Falhas nele    : $(if ($falhas) { $falhas.Count } else { 0 })"
      if ($falhas) { $falhas | ForEach-Object { "    $($_.Line.Trim())" } }
    }
    $t = schtasks /query /tn "RadarDeNoticias" 2>$null
    Write-Output "Agendamento    : $(if ($t) {'ativo (07:00)'} else {'nao agendado - rode: radar agendar'})"
  }

  # ---------- automacao ----------
  "agendar" {
    $hora = if ($arg) { $arg } else {
      (Get-Content (Join-Path $base "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json).horario_automatico }
    $acao = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$base\radar.ps1`" tudo"
    schtasks /create /tn "RadarDeNoticias" /tr $acao /sc daily /st $hora /f | Out-Null

    # Sem isto, se o PC estiver desligado as 07h a rodada e simplesmente PERDIDA.
    # StartWhenAvailable faz o Windows rodar assim que a maquina voltar.
    try {
      $t = Get-ScheduledTask -TaskName "RadarDeNoticias"
      $t.Settings.StartWhenAvailable = $true
      $t.Settings.ExecutionTimeLimit = "PT30M"   # nao deixa travar pra sempre
      Set-ScheduledTask -TaskName "RadarDeNoticias" -Settings $t.Settings | Out-Null
      Write-Output "Agendado todo dia as $hora (roda depois, se o PC estiver desligado na hora)."
    } catch {
      Write-Output "Agendado todo dia as $hora."
      Write-Output "AVISO: nao consegui ligar o 'rodar depois se perdeu o horario'."
    }
    Write-Output "Ver:      schtasks /query /tn RadarDeNoticias"
    Write-Output "Pausar:   radar pausar"
    Write-Output "Remover:  radar desinstalar"
  }
  "pausar"     { schtasks /change /tn "RadarDeNoticias" /disable | Out-Null; Write-Output "Agendamento pausado (nada foi apagado)." }
  "retomar"    { schtasks /change /tn "RadarDeNoticias" /enable  | Out-Null; Write-Output "Agendamento retomado." }
  "desinstalar"{ schtasks /delete /tn "RadarDeNoticias" /f | Out-Null; Write-Output "Agendamento removido. Os boletins e o historico continuam em $base" }

  "log" {
    $log = Get-ChildItem (Join-Path $base "logs") -Filter "*.log" | Sort-Object Name -Descending | Select-Object -First 1
    if ($log) { Get-Content $log.FullName -Tail 40 } else { Write-Output "Sem logs ainda." }
  }

  "abrir" {
    $u = Pasta-Ultima
    if ($u) { Start-Process (Join-Path $u.FullName "boletim.html") } else { Write-Output "Nenhum boletim ainda." }
  }

  default {
    @"

RADAR DE NOTICIAS - comandos

  radar                  roda tudo: coleta, monta o boletim, narra e notifica
  radar texto            so o boletim escrito
  radar voz              so o audio do ultimo boletim
  radar abrir            abre o boletim de hoje no navegador
  radar vozes            lista as vozes instaladas na maquina
  radar testarvoz [voz]  ouve uma frase curta pra comparar as vozes

  radar fontes           tabela de fontes com nota e status
  radar +fonte <url>     descobre o feed, valida, da nota e adiciona
  radar -fonte <nome>    desativa uma fonte (mantem o historico)
  radar nicho <texto>    mostra ou muda o nicho
  radar busca <tema>     pesquisa pontual, fora da rotina

  radar clipping         10 linhas prontas pra colar no WhatsApp do time
  radar ganchos          5 ideias de video com angulo contra-intuitivo
  radar opml             o arquivo pra importar as fontes no celular

  radar semana           resumao dos ultimos 7 dias
  radar arquivo <termo>  procura no historico
  radar status           ultima execucao, falhas e agendamento
  radar log              ultimas linhas do log

  radar agendar [HH:MM]  agenda pra rodar sozinho todo dia
  radar pausar           pausa o agendamento
  radar retomar          volta o agendamento
  radar desinstalar      remove o agendamento

"@
  }
}
