# Kokoro — voz neural do Radar

Modelo de fala de 82M parâmetros, licença Apache 2.0. Roda **local e offline**
depois do primeiro download. É a melhor das três vozes do Radar.

## Ordem das vozes

O `narrar.ps1` tenta nesta ordem e usa a primeira que funcionar:

| Motor | Qualidade | Velocidade | Onde está |
|---|---|---|---|
| **Kokoro** | melhor | ~1x tempo real | `kokoro/venv` |
| **Piper** | boa | ~8x mais rápido que o tempo real | `piper/` |
| **Windows (SAPI)** | básica | instantânea | já vem no sistema |

Pra forçar um motor: `"voz": { "motor": "kokoro" }` no `config.json`
(aceita `kokoro`, `piper`, `sapi` ou `auto`).

## Vozes em português

| Voz | |
|---|---|
| `pf_dora` | feminina *(padrão)* |
| `pm_alex` | masculina |
| `pm_santa` | masculina |

Trocar em `"voz": { "kokoro_voz": "pm_alex" }`. Pra ouvir antes de decidir:

```
radar testarvoz pm_alex
```

## Sobre o tempo de geração

Medido nesta máquina: **180 segundos pra gerar 173 segundos de áudio** (~1x
tempo real, CPU). O boletim diário roda agendado às 07:00, então isso não
atrapalha — mas por isso o Kokoro **não** serve pra resposta interativa.
O Piper faz o mesmo trabalho em segundos, com qualidade um pouco menor.

## Como foi instalado (pra refazer, se precisar)

O ambiente vive em `kokoro/venv` e **não está no git** (1,3 GB). Pra recriar:

```powershell
python -m venv kokoro\venv
kokoro\venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
kokoro\venv\Scripts\python.exe -m pip install numpy
kokoro\venv\Scripts\python.exe -m pip install kokoro --no-deps
kokoro\venv\Scripts\python.exe -m pip install soundfile loguru num2words huggingface-hub transformers misaki scipy spacy
kokoro\venv\Scripts\python.exe -m pip install phonemizer-fork espeakng-loader
winget install --id eSpeak-NG.eSpeak-NG -e
```

O modelo (~314 MB) baixa sozinho na primeira execução, pro cache do
HuggingFace em `~/.cache/huggingface`.

### Por que `kokoro --no-deps`

O pacote fixa `numpy==1.26.4`, versão anterior ao Python 3.14 e sem wheel
pronto — o pip tenta compilar do zero e falha. Instalando sem as dependências
e resolvendo na mão, ele funciona com o numpy 2.x. **Testado e gerando áudio.**

### Por que o espeak-ng

Pra português, o Kokoro converte texto em fonemas com o espeak-ng. Sem ele o
erro é `espeak not installed on your system`. No Windows a biblioteca não acha
a DLL sozinha, então o `falar.py` aponta o caminho na mão — primeiro o que vem
no pacote `espeakng-loader`, depois `C:\Program Files\eSpeak NG`.
