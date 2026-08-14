# -*- coding: utf-8 -*-
"""
RADAR DE NOTICIAS - pauta e clipping

Dois usos do boletim depois de pronto:

  clipping  -> 10 linhas prontas pra colar no WhatsApp do time (100% offline)
  ganchos   -> 5 ideias de video com angulo contra-intuitivo (precisa da
               camada de IA ligada, porque angulo contra-intuitivo exige
               interpretar a noticia, e isso um script sozinho nao faz)

Rode por: radar clipping   /   radar ganchos
"""

import io, json, os, re, sqlite3, sys
from datetime import datetime, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "historico.sqlite")
MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
         "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]


def cfg():
    return json.load(io.open(os.path.join(BASE, "config.json"), encoding="utf-8"))


def boletim_de_hoje():
    """Le o boletim mais recente ja gerado (nao coleta nada de novo)."""
    pastas = sorted(os.listdir(os.path.join(BASE, "boletins")), reverse=True)
    for p in pastas:
        caminho = os.path.join(BASE, "boletins", p, "boletim.md")
        if os.path.exists(caminho):
            return p, io.open(caminho, encoding="utf-8").read()
    return None, None


def itens_da_semana(dias=7):
    """Puxa do historico o que entrou em boletim nos ultimos N dias."""
    if not os.path.exists(DB):
        return []
    con = sqlite3.connect(DB)
    lim = (datetime.now() - timedelta(days=dias)).isoformat()
    linhas = con.execute(
        "SELECT titulo, veiculo, link, score FROM itens "
        "WHERE data_coleta>? AND usado=1 ORDER BY score DESC", (lim,)).fetchall()
    con.close()
    return [{"titulo": t, "veiculo": v, "link": l, "score": s} for t, v, l, s in linhas]


# ─────────────────────────── clipping ───────────────────────────

def clipping():
    """10 linhas pro WhatsApp. Sem IA: so condensa o que ja esta no boletim."""
    dia, md = boletim_de_hoje()
    if not md:
        print("Nenhum boletim gerado ainda. Rode 'radar' primeiro.")
        return

    # pega manchete + veiculo + link direto do markdown do boletim
    titulos = re.findall(r"^### \[\d+\] (.+)$", md, re.M)
    veiculos = re.findall(r"^(.+?) · \d{2}/\d{2} · leitura", md, re.M)
    links = re.findall(r"^\*\*Link:\*\* (\S+)", md, re.M)

    d = datetime.strptime(dia, "%Y-%m-%d")
    c = cfg()
    # capitaliza so a primeira letra: .title() deixaria "Mercado De Energia"
    tema = c["nicho"].split(" e ")[0].strip()
    tema = tema[:1].upper() + tema[1:]
    linhas = [f"*Radar {tema} — {d.day}/{d.month:02d}*", ""]

    # 8 manchetes + cabecalho + rodape = 10 linhas
    for i, t in enumerate(titulos[:8]):
        v = veiculos[i] if i < len(veiculos) else ""
        # WhatsApp fica ilegivel com linha gigante: corta no tamanho de leitura
        t = t if len(t) <= 95 else t[:92].rsplit(" ", 1)[0] + "..."
        linhas.append(f"{i+1}. {t}" + (f" _({v})_" if v else ""))

    linhas.append("")
    linhas.append(f"_{len(titulos)} notícias · boletim completo e áudio no radar_")

    texto = "\n".join(linhas)
    saida = os.path.join(BASE, "boletins", dia, "clipping-whatsapp.txt")
    io.open(saida, "w", encoding="utf-8").write(texto)

    print(texto)
    print()
    print(f">> salvo em {saida}")
    # links separados, pra quem quiser mandar junto
    if links:
        print(">> links (mande em mensagem separada, senão o WhatsApp gera 8 previews):")
        for i, l in enumerate(links[:8], 1):
            print(f"   {i}. {l}")


# ─────────────────────────── ganchos ───────────────────────────

INSTRUCAO_GANCHOS = """Você cria pautas de vídeo curto (Reels/TikTok) sobre {nicho}.

Recebeu as notícias que mais performaram na semana. Gere 5 ideias de vídeo com
ÂNGULO CONTRA-INTUITIVO: o que contraria o senso comum, o que a manchete não
disse, quem perde enquanto todo mundo comemora, o efeito de segunda ordem.

REGRAS:
- Baseie cada ideia numa notícia REAL da lista. Cite qual (campo "base").
- NUNCA invente número, empresa ou fato que não esteja na lista.
- O gancho é a primeira frase falada: no máximo 15 palavras, sem clickbait vazio.
- "porque" explica em 1 frase por que esse ângulo é contra-intuitivo.
- Sem emoji, sem hashtag, sem markdown.

Responda SOMENTE com JSON:
{{"ganchos": [{{"gancho": "...", "angulo": "...", "porque": "...", "base": "..."}}]}}"""


def ganchos():
    itens = itens_da_semana()
    if not itens:
        print("Sem histórico da semana ainda. Rode 'radar' alguns dias primeiro.")
        return

    c = cfg()
    conf = c.get("resumo", {})
    chave = os.environ.get(conf.get("chave_env", "RADAR_IA_KEY"), "").strip()
    if not chave:
        print("Os ganchos precisam da camada de IA ligada — é ela que interpreta a")
        print("notícia pra achar o ângulo contra-intuitivo. Um script sozinho não faz isso.")
        print()
        print("Pra ligar (grátis, sem cartão):")
        print('  1) pegue uma chave em console.groq.com')
        print('  2) setx RADAR_IA_KEY "sua-chave"')
        print('  3) feche e abra o terminal, e rode: radar ganchos')
        print()
        print(f"Enquanto isso, as {min(8,len(itens))} notícias mais fortes da semana:")
        for i, x in enumerate(itens[:8], 1):
            print(f"  {i}. [{x['score']}] {x['titulo'][:72]} ({x['veiculo']})")
        return

    import resumir
    prov = resumir.PROVEDORES.get((conf.get("provedor") or "groq").lower())
    if not prov:
        print("Provedor desconhecido no config.json.")
        return

    lista = [{"titulo": x["titulo"], "veiculo": x["veiculo"]} for x in itens[:15]]
    sistema = INSTRUCAO_GANCHOS.format(nicho=c.get("nicho", "negócios"))
    usuario = json.dumps({"noticias_da_semana": lista}, ensure_ascii=False)

    try:
        if prov["compat"]:
            data = resumir._http_json(prov["url"], {
                "model": prov["modelo"], "max_tokens": 2000,
                "messages": [{"role": "system", "content": sistema},
                             {"role": "user", "content": usuario}],
            }, {"authorization": "Bearer " + chave})
            bruto = data["choices"][0]["message"]["content"]
        else:
            url = prov["url"].format(m=prov["modelo"], k=chave)
            data = resumir._http_json(url, {
                "systemInstruction": {"parts": [{"text": sistema}]},
                "contents": [{"role": "user", "parts": [{"text": usuario}]}],
                "generationConfig": {"maxOutputTokens": 2000},
            }, {})
            bruto = data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print(f"Falha ao falar com a IA ({type(e).__name__}). Tente de novo mais tarde.")
        return

    obj = resumir._extrair_json(bruto)
    if not obj or "ganchos" not in obj:
        print("A resposta veio fora do formato. Tente de novo.")
        return

    hoje = datetime.now()
    linhas = [f"# Pauta da semana — {hoje.day} de {MESES[hoje.month]}", ""]
    print(f"\n5 GANCHOS COM ÂNGULO CONTRA-INTUITIVO\n{'='*66}")
    for i, g in enumerate(obj["ganchos"][:5], 1):
        bloco = [f"## [{i}] {g.get('gancho','')}",
                 f"**Ângulo:** {g.get('angulo','')}",
                 f"**Por que é contra-intuitivo:** {g.get('porque','')}",
                 f"**Base:** {g.get('base','')}", ""]
        linhas += bloco
        print(f"\n[{i}] {g.get('gancho','')}")
        print(f"    ângulo : {g.get('angulo','')}")
        print(f"    porquê : {g.get('porque','')}")
        print(f"    base   : {g.get('base','')}")

    dia, _ = boletim_de_hoje()
    if dia:
        saida = os.path.join(BASE, "boletins", dia, "pauta-ganchos.md")
        io.open(saida, "w", encoding="utf-8").write("\n".join(linhas))
        print(f"\n>> salvo em {saida}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "clipping"
    os.chdir(BASE)
    sys.path.insert(0, BASE)
    if cmd == "ganchos":
        ganchos()
    else:
        clipping()
