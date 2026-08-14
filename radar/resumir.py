# -*- coding: utf-8 -*-
"""
RADAR DE NOTICIAS - camada de resumo editorial (modo "ia")

Por que isso existe: o RSS quase sempre entrega SO a manchete. Pra escrever
os 5 bullets, o "por que isso importa" e o angulo de uso, e preciso LER a
materia e interpretar - e isso um script sozinho nao faz.

Esta camada e OPCIONAL e desligada por padrao. Ela so liga se voce colocar
uma chave GRATUITA numa variavel de ambiente. Nenhum servico pago e usado.

COMO LIGAR (escolha um, todos tem camada gratuita sem cartao):
  Groq     -> console.groq.com          (mais rapido)
  Gemini   -> aistudio.google.com       (escreve melhor)
  Cerebras -> cloud.cerebras.ai
  Mistral  -> console.mistral.ai

  1) pegue a chave no site
  2) guarde na maquina (uma vez so):
       setx RADAR_IA_KEY "sua-chave-aqui"
  3) no config.json, mude:  "resumo": { "modo": "ia", "provedor": "groq" }
  4) feche e abra o terminal (pro setx valer) e rode: radar

Se a chave nao existir ou a chamada falhar, o radar volta sozinho pro modo
local e o boletim sai do mesmo jeito - so mais enxuto. Nunca fica sem boletim.
"""

import json, os, re, sys, urllib.request, urllib.error

# provedores com camada gratuita. "compat" = fala o mesmo formato da OpenAI.
PROVEDORES = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "modelo": "llama-3.3-70b-versatile", "compat": True,
    },
    "cerebras": {
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "modelo": "llama-3.3-70b", "compat": True,
    },
    "mistral": {
        "url": "https://api.mistral.ai/v1/chat/completions",
        "modelo": "mistral-medium-latest", "compat": True,
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "modelo": "google/gemini-2.0-flash-exp:free", "compat": True,
    },
    "gemini": {
        "url": "https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={k}",
        "modelo": "gemini-2.5-flash", "compat": False,
    },
}

INSTRUCAO = """Você é o editor-chefe de um boletim diário sobre {nicho}.

Para CADA notícia da lista, escreva em português do Brasil:
- "bullets": 3 a 5 frases curtas com o que aconteceu. Use número e data quando existirem NO TEXTO.
- "importa": 2 frases conectando a notícia com o nicho de quem lê.
- "angulo": 1 frase de como isso vira post, argumento comercial ou decisão.

REGRAS INEGOCIÁVEIS:
- NUNCA invente número, data, empresa, cargo ou declaração. Só use o que está no texto recebido.
- Se o texto recebido for apenas a manchete, diga em "bullets" que o feed só trouxe a manchete
  e NÃO tente adivinhar o conteúdo. É melhor admitir do que inventar.
- Não copie frases do original. Escreva com suas palavras.
- Sem emoji, sem markdown, sem hashtag. O texto será lido em voz alta.

Responda SOMENTE com um JSON no formato:
{{"itens": [{{"i": 1, "bullets": ["..."], "importa": "...", "angulo": "..."}}]}}"""


def _http_json(url, payload, headers, timeout=90):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _extrair_json(txt):
    """O modelo as vezes embrulha o JSON em ```json ... ``` ou em texto solto."""
    txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
    i, f = txt.find("{"), txt.rfind("}")
    if i == -1 or f == -1:
        return None
    try:
        return json.loads(txt[i:f + 1])
    except json.JSONDecodeError:
        return None


def resumir(itens, cfg, log=print):
    """Devolve {indice: {bullets, importa, angulo}} ou None se nao der pra usar IA."""
    conf = cfg.get("resumo", {})
    if conf.get("modo") != "ia":
        return None

    prov_nome = (conf.get("provedor") or "groq").lower()
    prov = PROVEDORES.get(prov_nome)
    if not prov:
        log(f"  [ia] provedor '{prov_nome}' desconhecido - usando modo local")
        return None

    chave = os.environ.get(conf.get("chave_env", "RADAR_IA_KEY"), "").strip()
    if not chave:
        log(f"  [ia] sem chave em {conf.get('chave_env')} - usando modo local")
        return None

    # pacote compacto: manda so o que a IA precisa, pra gastar pouco token
    lista = []
    for n, it in enumerate(itens, 1):
        lista.append({
            "i": n,
            "titulo": it["titulo"],
            "veiculo": it["veiculo"],
            # Prefere o corpo aberto na materia. O resumo do RSS vem truncado
            # em ~55 palavras, entao a IA escrevia por cima de meia noticia -
            # com o corpo, ela resume o texto de verdade.
            "texto": (" ".join(it.get("corpo") or []) or it["resumo"] or "")[:3000]
                     or "(o feed trouxe apenas a manchete)",
        })

    sistema = INSTRUCAO.format(nicho=cfg.get("nicho", "negócios"))
    usuario = json.dumps({"noticias": lista}, ensure_ascii=False)

    try:
        if prov["compat"]:
            data = _http_json(prov["url"], {
                "model": prov["modelo"],
                "max_tokens": 3000,
                "messages": [{"role": "system", "content": sistema},
                             {"role": "user", "content": usuario}],
            }, {"authorization": "Bearer " + chave})
            bruto = data["choices"][0]["message"]["content"]
        else:  # gemini
            url = prov["url"].format(m=prov["modelo"], k=chave)
            data = _http_json(url, {
                "systemInstruction": {"parts": [{"text": sistema}]},
                "contents": [{"role": "user", "parts": [{"text": usuario}]}],
                "generationConfig": {"maxOutputTokens": 3000},
            }, {})
            bruto = data["candidates"][0]["content"]["parts"][0]["text"]
    except urllib.error.HTTPError as e:
        corpo = ""
        try:
            corpo = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        log(f"  [ia] {prov_nome} recusou (HTTP {e.code}) - usando modo local. {corpo}")
        return None
    except Exception as e:
        log(f"  [ia] falha em {prov_nome} ({type(e).__name__}) - usando modo local")
        return None

    obj = _extrair_json(bruto)
    if not obj or "itens" not in obj:
        log("  [ia] resposta veio fora do formato - usando modo local")
        return None

    saida = {}
    for x in obj["itens"]:
        try:
            i = int(x["i"])
        except (KeyError, ValueError, TypeError):
            continue
        bullets = x.get("bullets") or []
        if isinstance(bullets, str):
            bullets = [bullets]
        saida[i] = {
            "bullets": [str(b).strip() for b in bullets if str(b).strip()][:5],
            "importa": str(x.get("importa", "")).strip(),
            "angulo": str(x.get("angulo", "")).strip(),
        }
    if not saida:
        return None
    log(f"  [ia] {prov_nome} escreveu {len(saida)} resumo(s) editoriais")
    return saida
