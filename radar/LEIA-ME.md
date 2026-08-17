# Radar de Notícias — módulo do Jarvis

Boletim diário do nicho **energia + seguros/corretagem**: coleta RSS, monta o
texto, narra em áudio e entrega tudo dentro do Jarvis. Roda 100% offline
exceto pelo download dos feeds — nenhuma API paga, nenhuma chave obrigatória.

## Onde este código roda

**Aqui mesmo.** Esta pasta é a instalação: código versionado e execução no
mesmo lugar, sem cópia para sincronizar.

Nem sempre foi assim. Até 17/08/2026 o Radar rodava em
`C:\Users\<usuario>\RadarDeNoticias\` e o repositório guardava só um espelho —
arranjo que existia porque **virtualenv do Python não é relocável** (os scripts
dentro dele gravam caminhos absolutos na criação), então mover o venv de 1,3 GB
do Kokoro quebraria a narração. A saída foi **recriar** o ambiente aqui, não
movê-lo. Levou uns 10 minutos, quase tudo download do torch.

O que **não** é versionado (veja o `.gitignore`): `boletins/`, `logs/`,
`historico.sqlite`, o venv do Kokoro e o binário do Piper — tudo gerado ou
reinstalável.

### Se precisar recriar noutra máquina

```powershell
python -m venv kokoro\venv
kokoro\venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
kokoro\venv\Scripts\python.exe -m pip install numpy
kokoro\venv\Scripts\python.exe -m pip install kokoro --no-deps
kokoro\venv\Scripts\python.exe -m pip install soundfile loguru num2words huggingface-hub transformers misaki scipy spacy
kokoro\venv\Scripts\python.exe -m pip install phonemizer-fork espeakng-loader
winget install --id eSpeak-NG.eSpeak-NG -e
```

O modelo (~314 MB) baixa sozinho na primeira execução, para o cache do
HuggingFace em `~/.cache/huggingface` — que é compartilhado entre ambientes,
então recriar o venv **não** rebaixa o modelo.

O `kokoro --no-deps` é obrigatório: o pacote fixa `numpy==1.26.4`, versão sem
wheel para o Python 3.14, e o pip tenta compilar do zero e falha. Resolvendo as
dependências à mão ele roda com numpy 2.x.

## Como o Jarvis consome

Acoplamento por arquivo, não por processo. O `narrar.ps1` grava
`agent-state/radar-boletim.json` no fim da narração; a antena (`server.js`)
só lê.

| Rota | Devolve |
|---|---|
| `GET /api/radar` | manchetes, duração e caminhos do boletim do dia |
| `GET /api/radar/audio` | o `.m4a`, pelo caminho que o Radar registrou |

O caminho do áudio **nunca** vem da URL — se viesse, a rota viraria leitura de
arquivo arbitrário na máquina.

No painel aparecem dois agentes, que são coisas diferentes:

- **`radar-noticias`** — este boletim narrado, das 07:00
- **`news-radar`** — o vigia de assuntos que roda dentro do próprio Jarvis

## Comandos

```
radar                 coleta + boletim + áudio + notificação
radar texto           só o boletim escrito
radar voz             só o áudio do último boletim
radar fontes          tabela de fontes com nota e status
radar +fonte <url>    descobre o feed, valida, dá nota e adiciona
radar -fonte <nome>   desativa sem apagar o histórico
radar nicho <texto>   muda o nicho
radar busca <tema>    pesquisa pontual, fora da rotina
radar semana          resumão dos 7 dias
radar arquivo <termo> procura no histórico
radar status          última execução, falhas, fontes mortas
radar vozes           motores de voz instalados
radar testarvoz [voz] amostra curta pra comparar vozes
```

## Configuração

Tudo em `config.json` — não precisa mexer em código. Nicho, palavras-chave,
bloqueios, janela de tempo, número de artigos, voz e horário.

A chave de IA é **opcional**: com `resumo.modo = "ia"` e a variável de ambiente
`RADAR_IA_KEY` preenchida, uma IA gratuita escreve os campos editoriais
("por que isso importa", "ângulo pra usar"). Sem ela, o boletim sai igual pelo
caminho local. A chave nunca fica no repositório — só o **nome** da variável.

## Armadilhas já pagas (não repita)

**PowerShell 5.1 grava BOM.** `Set-Content -Encoding UTF8` cola `EF BB BF` no
início do arquivo e o `json.load` do Python quebra na hora. Todas as escritas de
JSON usam `[System.IO.File]::WriteAllText` com `UTF8Encoding($false)`.

**Os `.ps1` deste projeto são ASCII puro.** O PowerShell 5.1 lê UTF-8 sem BOM
como ANSI — dois travessões já custaram 19 erros de sintaxe.

**Nada de `[string]$cmd` no `param()`.** Com um parâmetro nomeado declarado, o
PowerShell tenta casar `-fonte` como *nome* de parâmetro e o comando se perde.
Tudo entra por um `ValueFromRemainingArguments` só.

**A cascata de vozes julga pelo arquivo gerado**, nunca pelo código de saída ou
pelo stderr — biblioteca de ML escreve aviso em stderr mesmo dando tudo certo.
Kokoro → Piper → voz do Windows, e cada etapa precisa checar **todas** as
anteriores; checando só a última, o SAPI sobrescrevia um áudio bom.

**A página de notícia tem vários `<article>`.** Os cards de "leia também"
também são `<article>` — pegando o primeiro, vinha a matéria errada. O
`_paragrafos()` testa cada bloco e fica com o que tem mais texto.

**`RobotFileParser.read()` usa o User-Agent do Python**, que vários sites
respondem com 403 — e o parser lê 403 como "proibido tudo". O `robots.txt` é
baixado com o nosso próprio User-Agent.
