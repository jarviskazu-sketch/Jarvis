# -*- coding: utf-8 -*-
"""
ANALISTA — camada 3 do Jarvis-cerebro.

Uma vez por dia, olha o que as camadas 1 e 2 marcaram como estranho e escreve
algumas linhas de interpretacao no diario do segundo cerebro.

O PRINCIPIO QUE MANDA AQUI: a IA nao varre, ela explica.
Quem varre e conta e este script, que e deterministico, gratuito e confiavel.
A IA recebe so o resumo do que ja foi apontado - nunca os eventos crus. E o
que torna isso sustentavel numa maquina de 4 nucleos e o que faz o texto ser
confiavel em vez de plausivel.

MOTOR: Ollama local (llama3.2:3b). Sem chave, sem nuvem, sem mensalidade -
mesma regra que vale pro resto do projeto.

SE A IA NAO RESPONDER, o registro factual e escrito do mesmo jeito. Um dia sem
interpretacao ainda e um dia registrado; um dia sem registro some pra sempre.

Uso:  python analista.py
"""

import json, os, re, sys, urllib.request, urllib.error
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
ESTADO = os.path.join(BASE, "agent-state")
DIARIO = r"D:\SEGUNDO-CEREBRO\90-DIARIO"

OLLAMA = "http://127.0.0.1:11434/api/generate"
# CASCATA DE MODELOS, do melhor pro que cabe em qualquer lugar.
#
# Mesmo padrao das vozes do Radar (Kokoro > Piper > SAPI): tenta o melhor, cai
# pro seguinte se nao der, e nunca fica sem entregar. Aqui a razao e memoria.
#
# Esta maquina vive com pouca RAM livre - o gateway do Power BI e o Analysis
# Services seguram varios GB o dia inteiro. Em 26/08 o analista quebrou com
# "failed to allocate buffer of size 3121348608": o qwen2.5:7b nao coube.
#
# Qualidade medida na mesma entrada (2 problemas reais):
#   qwen2.5:7b   73s  fatos corretos, terceira pessoa, comeca pelo defeito
#   llama3.2:3b  15s  entende o essencial, mas escorrega em detalhe
#   qwen2.5:3b   32s  descartado: inventou que o cerebro mexe na agenda
#
# O "precisa_gb" e o peso do modelo mais folga pro cache de contexto e pro
# resto do sistema. Sem essa checagem previa, a tentativa condenada ainda
# custa o tempo de carregar o arquivo do disco antes de estourar.
MODELOS = [
    {"nome": "qwen2.5:7b",  "precisa_gb": 6.0},
    {"nome": "llama3.2:3b", "precisa_gb": 3.0},
]

# num_ctx pequeno de proposito: o llama3.2 tem janela de 128k e o Ollama
# reserva memoria pro cache de contexto ANTES de saber o tamanho do texto.
# Com a maquina cheia (Power BI + gateway ocupam vaarios GB), o padrao estoura
# com "failed to allocate buffer for kv cache". A entrada aqui e pequena.
NUM_CTX = 4096
# keep_alive 0 descarrega o modelo assim que termina, devolvendo ~2 GB.
KEEP_ALIVE = 0

MARCA = "## 🔎 Análise do dia"


def ler_json(caminho):
    """Le JSON tolerando BOM - o PowerShell grava com BOM por padrao."""
    try:
        with open(caminho, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return None


def coletar_fatos():
    """Separa o que esta ERRADO do que e so numero do dia.

    A distincao e o coracao da camada 3. Numero saudavel nao pode chegar na
    IA: com "281 itens varridos" e "332 eventos na agenda" na entrada, o
    modelo de 3B respondeu que "o boletim esta em desordem" e "a agenda esta
    desorganizada" - inventou diagnostico a partir de contagem neutra, que e
    justamente o erro que essa arquitetura existe pra evitar.

    Entao: a IA so recebe PROBLEMA. Os numeros do dia vao pro registro escrito,
    onde nao correm risco de virar interpretacao."""
    problemas = []
    numeros = []

    vigia = ler_json(os.path.join(ESTADO, "vigia.json"))
    if vigia:
        problemas.extend(vigia.get("alertas") or [])
    else:
        problemas.append("O vigia nao gerou estado - a antena pode estar fora do ar.")

    for arq, rotulo in [("radar-noticias.json", "Boletim do dia"),
                        ("news-radar.json", "Vigia de assuntos"),
                        ("agenda-sync.json", "Agenda"),
                        ("cerebro-sync.json", "Segundo cerebro")]:
        d = ler_json(os.path.join(ESTADO, arq))
        if d and d.get("detail"):
            numeros.append(f"{rotulo}: {d['detail']}")

    # De proposito NAO entram as manchetes do dia.
    # Na primeira versao elas entravam, e o resultado foi o modelo largar o
    # problema real (o cerebro fora do ar) pra comentar reajuste de tarifa na
    # Paraiba - virou um editorial de jornal. Noticia ja tem o boletim inteiro
    # pra ela; aqui o assunto e a SAUDE DO SISTEMA. Modelo pequeno segue o
    # material mais chamativo que voce der, entao nao se da material errado.

    return problemas, numeros


def desambiguar(texto):
    """Reescreve os fragmentos comprimidos do painel em portugues inteiro.

    Os alertas sao escritos pra caber numa linha de painel: "· 5 na fila",
    'rode "claude"'. Humano le sem problema; modelo de linguagem le "5 na fila"
    como "quinta posicao na fila" e o comando `claude` como nome de usuario -
    aconteceu com os tres modelos testados.

    Corrigir isso e trabalho DESTA camada, nao da IA: ambiguidade de formato se
    resolve com substituicao deterministica. Sobra pra IA so o que ela faz bem,
    que e interpretar."""
    t = texto
    t = re.sub(r"·?\s*(\d+)\s+na fila\b",
               lambda m: f"e {m.group(1)} sessões estão paradas esperando para serem processadas", t)
    t = re.sub(r'rode\s+"claude"\s+e entre de novo',
               "é preciso abrir um terminal e executar o programa chamado claude para fazer login de novo", t)
    t = re.sub(r"\s*·\s*", ", ", t)
    return re.sub(r"\s+", " ", t).strip()


def ram_livre_gb():
    """Memoria fisica disponivel, via API do proprio Windows (ctypes e stdlib).
    Devolve None se nao der pra medir - nesse caso a gente tenta assim mesmo em
    vez de desistir por precaucao."""
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        m = MEMORYSTATUSEX()
        m.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return None
        return m.ullAvailPhys / (1024 ** 3)
    except Exception:
        return None


def pedir_analise(problemas):
    """Percorre a cascata de modelos e devolve (texto, modelo_usado, erro).

    Cai pro proximo tanto por falta de memoria PREVISTA (checagem antes) quanto
    por falha na hora (o Ollama pode estourar mesmo com a conta fechando, se
    outro programa pegar a memoria no meio)."""
    problemas = [desambiguar(p) for p in problemas]
    livre = ram_livre_gb()
    ultimo_erro = "nenhum modelo tentado"

    for m in MODELOS:
        if livre is not None and livre < m["precisa_gb"]:
            ultimo_erro = (f"sem memória livre suficiente: {livre:.1f} GB disponíveis, "
                           f"o menor modelo precisa de {MODELOS[-1]['precisa_gb']:.0f} GB")
            continue
        txt, erro = _chamar_ollama(m["nome"], problemas)
        if txt:
            return txt, m["nome"], None
        ultimo_erro = f"{m['nome']}: {erro}"

    return None, None, ultimo_erro


def _chamar_ollama(modelo, problemas):
    """Uma tentativa, num modelo so."""
    # O prompt e chato de proposito. Modelo de 3B improvisa quando sobra espaco:
    # sem o "fale na terceira pessoa" ele escrevia "isso me preocupa" como se
    # fosse o proprio dono; sem o "assunto e o sistema" ele comentava o mundo.
    prompt = (
        # NAO liste os robos aqui. A versao anterior descrevia "um que sincroniza
        # agenda, um que cuida das anotacoes" e o modelo fundiu os dois, dizendo
        # que o Segundo Cerebro cuidava da agenda. Cada alerta ja vem com o nome
        # do robo; descrever o elenco so cria chance de trocar os papeis.
        "Voce monitora robos que rodam sozinhos no computador do Mateus.\n\n"
        "O QUE ESTA COM DEFEITO HOJE:\n" + "\n".join("- " + p for p in problemas) + "\n\n"
        "Escreva no maximo 3 frases curtas, em portugues do Brasil, sobre O QUE ESTA "
        "ACONTECENDO COM ESSES ROBOS e o que o Mateus precisa fazer.\n"
        "Regras:\n"
        "- Fale do Mateus na terceira pessoa. Nunca escreva 'eu', 'me' ou 'para mim'.\n"
        "- Comece pelo que esta quebrado, se houver algo quebrado.\n"
        "- Nao comente noticias, economia, energia nem o mundo la fora. So os robos.\n"
        "- Nao invente nada que nao esteja na lista acima.\n"
        "- NAO repita numeros, datas nem comandos: eles ja aparecem escritos logo "
        "abaixo do seu texto. Diga so o que esta acontecendo e o que ele precisa fazer.\n"
        "- Texto corrido, sem lista e sem titulo."
    )
    corpo = {
        "model": modelo, "prompt": prompt, "stream": False,
        "keep_alive": KEEP_ALIVE,
        "options": {"num_ctx": NUM_CTX, "temperature": 0.3, "num_predict": 300},
    }
    try:
        req = urllib.request.Request(
            OLLAMA, data=json.dumps(corpo).encode("utf-8"),
            headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=900) as r:
            d = json.load(r)
        txt = (d.get("response") or "").strip()
        return (txt, None) if txt else (None, "o modelo respondeu vazio")
    except urllib.error.HTTPError as e:
        detalhe = ""
        try:
            detalhe = json.loads(e.read().decode("utf-8", "replace")).get("error", "")
        except Exception:
            pass
        return None, f"HTTP {e.code} {detalhe[:160]}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def escrever_no_diario(analise, problemas, numeros, erro, modelo=None):
    """Grava no diario do dia, SUBSTITUINDO a analise anterior se ja houver uma.

    Substituir em vez de acrescentar importa: rodar duas vezes no mesmo dia
    encheria o diario de blocos repetidos. E o arquivo e compartilhado com a
    destilacao automatica, entao a gente le, mexe so na nossa secao e devolve -
    nunca reescreve o arquivo inteiro do zero."""
    os.makedirs(DIARIO, exist_ok=True)
    hoje = datetime.now().strftime("%Y-%m-%d")
    caminho = os.path.join(DIARIO, f"{hoje}.md")

    if os.path.exists(caminho):
        with open(caminho, encoding="utf-8-sig") as f:
            texto = f.read()
    else:
        texto = (f"---\ntitulo: Diário {hoje}\ntipo: diario\narea: DIARIO\n"
                 f'cor: "#6B7280"\nresumo: Registro automático de {hoje}\n'
                 f"tags: [diario]\ncriado: {hoje}\natualizado: {hoje}\n---\n\n"
                 f"# Diário — {hoje}\n")

    # tira a nossa secao anterior (dela ate o proximo "## " ou o fim)
    texto = re.sub(rf"\n{re.escape(MARCA)}.*?(?=\n## |\Z)", "", texto, flags=re.S)

    bloco = [f"\n{MARCA}", ""]
    if analise:
        bloco.append(analise)
    elif erro:
        bloco.append(f"_A análise não pôde ser escrita hoje ({erro}). "
                     f"O registro abaixo foi gravado mesmo assim._")
    else:
        bloco.append("_Nenhum agente com problema hoje — nada a interpretar._")

    if problemas:
        bloco += ["", "**Problemas:**", ""] + [f"- {p}" for p in problemas]
    bloco += ["", "**Números do dia:**", ""] + [f"- {n}" for n in numeros]

    # Qual modelo escreveu fica registrado: um texto do 3B nao pode ser lido
    # depois como se tivesse a precisao do 7B.
    if modelo:
        bloco += ["", f"<sub>Análise escrita por {modelo}, local.</sub>"]
    bloco.append("")

    with open(caminho, "w", encoding="utf-8") as f:
        f.write(texto.rstrip() + "\n" + "\n".join(bloco))
    return caminho


def escrever_estado(ok, detalhe, n):
    """Prova de vida no mesmo formato dos outros agentes: assim o VIGIA passa a
    vigiar o analista tambem. Se ele parar, o boletim avisa - que e exatamente
    o que faltou quando o Radar morreu por 7 dias."""
    estado = {
        "last_run": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ok": bool(ok), "detail": detalhe, "count": n,
    }
    with open(os.path.join(ESTADO, "analista.json"), "w", encoding="utf-8") as f:
        json.dump(estado, f, ensure_ascii=False, indent=2)


def main():
    problemas, numeros = coletar_fatos()
    if not problemas and not numeros:
        escrever_estado(False, "nenhum dado coletado - agent-state vazio?", 0)
        print("Nada pra analisar.")
        return 1

    # DIA SEM PROBLEMA NAO CHAMA IA.
    # Nao e economia de CPU: e a regra de que a IA so explica o que a contagem
    # ja apontou. Pedir "analise" de um dia normal e pedir pra ela inventar
    # alguma coisa - e ela inventa. O registro do dia sai igual, sem opiniao.
    analise, modelo, erro = (None, None, None)
    if problemas:
        analise, modelo, erro = pedir_analise(problemas)

    caminho = escrever_no_diario(analise, problemas, numeros, erro, modelo)

    if not problemas:
        escrever_estado(True, "dia sem problemas — registro gravado", 0)
        print(f"Nenhum agente com problema. Registro em {caminho}")
    elif analise:
        escrever_estado(True, f"{len(problemas)} problema(s) interpretado(s) por {modelo}", len(problemas))
        print(f"Análise escrita em {caminho} ({modelo})\n\n{analise}")
    else:
        # ok=True de proposito quando foi falta de memoria.
        # Maquina cheia nao e defeito do analista: ele fez o que dava, gravou os
        # fatos e disse por que nao interpretou. Marcar como falha encheria o
        # boletim de alarme sobre uma coisa que ninguem precisa consertar - e
        # alarme que toca a toa e alarme que se aprende a ignorar.
        # ok = foi_memoria: maquina cheia conta como sucesso (fez o que dava),
        # motor quebrado conta como falha (precisa de conserto e o Vigia deve
        # gritar). Na primeira versao isso estava invertido e o analista se
        # acusava de defeito toda vez que o computador estava ocupado.
        foi_memoria = "memória" in (erro or "")
        escrever_estado(foi_memoria,
                        ("registro gravado sem análise — " + erro) if foi_memoria
                        else f"motor de análise fora: {erro}",
                        len(problemas))
        print(f"Registro em {caminho}, sem análise: {erro}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
