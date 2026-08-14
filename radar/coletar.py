#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RADAR DE NOTICIAS - coletor
Baixa os feeds, filtra, deduplica, ranqueia e monta o boletim do dia.

Usa SOMENTE a biblioteca padrao do Python (nada de pip install).
Nao usa nenhuma API paga nem chave de acesso.

O QUE VOCE PROVAVELMENTE VAI QUERER MUDAR esta no config.json,
nao aqui: nicho, palavras-chave, bloqueios, quantidade de artigos,
janela de tempo, voz e horario.
"""

import json, os, re, sys, sqlite3, hashlib, html, unicodedata
import urllib.request, urllib.error, urllib.parse, urllib.robotparser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

# no Windows o terminal costuma ser cp1252 e quebra com acento/emoji
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
FONTES_PATH = os.path.join(BASE, "fontes.json")
DB_PATH = os.path.join(BASE, "historico.sqlite")
BOLETINS = os.path.join(BASE, "boletins")
LOGS = os.path.join(BASE, "logs")

TIMEOUT = 15  # segundos por feed - fonte lenta nao trava o resto
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


# ─────────────────────────── utilidades ───────────────────────────

def log(msg, arquivo=None):
    linha = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(linha)
    if arquivo:
        with open(arquivo, "a", encoding="utf-8") as f:
            f.write(linha + "\n")


def sem_acento(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def baixar(url, timeout=TIMEOUT):
    """Baixa uma URL com User-Agent de navegador. Devolve texto ou levanta erro."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        bruto = r.read()
    for enc in ("utf-8", "latin-1"):
        try:
            return bruto.decode(enc)
        except UnicodeDecodeError:
            continue
    return bruto.decode("utf-8", errors="replace")


# ═══════════════ leitura do artigo (conserta o resumo cortado) ═══════════════
#
# O RSS quase sempre entrega o resumo truncado - o WordPress corta em ~55
# palavras e cola "[...]". Isso vazava pro boletim como frase pela metade
# ("Segundo a Susep explicou que a proposta visa enfrentar") e pro audio.
# A saida e abrir a materia e pegar os paragrafos de verdade.
#
# LIMITES QUE ESTE CODIGO RESPEITA (Fase 0.5 do projeto):
#   - consulta o robots.txt do site antes de baixar, e desiste se for proibido
#   - so roda para as poucas noticias JA escolhidas, nunca para as ~300 varridas
#   - se detectar paywall, fica com o que e publico e marca o item
#   - qualquer erro devolve None e o boletim segue com o texto do RSS

TIMEOUT_ARTIGO = 12          # segundos por materia; passou disso, desiste
MAX_PARAGRAFOS = 6           # quanto do corpo aproveitar
_robots_cache = {}

# So marcas INEQUIVOCAS de conteudo bloqueado. Termos como "ja e assinante" ou
# "seja assinante" saem em link de login e em banner de venda de QUALQUER
# pagina do site - com eles na lista, o MegaWhat vinha marcado [paywall]
# mesmo com a materia inteira aberta.
MARCAS_PAYWALL = [
    "conteudo exclusivo para assinantes", "exclusivo para assinantes",
    "assine para continuar", "assine e continue", "continue lendo com",
    "este conteudo e exclusivo", "para continuar lendo, assine",
    'isaccessibleforfree":false', 'isaccessibleforfree": false',
]


def robots_permite(url):
    """Le o robots.txt do dominio (uma vez por dominio) e pergunta se o nosso
    User-Agent pode buscar esta pagina. Erro ao ler robots = liberado, que e o
    comportamento padrao da web; robots dizendo 'nao' = nao busca, ponto."""
    try:
        p = urllib.parse.urlsplit(url)
        raiz = f"{p.scheme}://{p.netloc}"
    except Exception:
        return False
    if raiz not in _robots_cache:
        # Baixamos o robots.txt com o NOSSO User-Agent em vez de usar rp.read().
        # O read() do Python usa o UA padrao "Python-urllib", que varios sites
        # bloqueiam com 403 - e o RobotFileParser interpreta 403 como "proibido
        # tudo". Resultado: o CQCS, que tem robots.txt vazio (ou seja, libera
        # geral), estava sendo tratado como bloqueado e nenhuma materia dele
        # era aberta.
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(raiz + "/robots.txt")
        try:
            texto = baixar(raiz + "/robots.txt", timeout=8)
            rp.parse(texto.splitlines())
        except Exception:
            rp = None          # sem robots.txt legivel: segue o padrao da web (liberado)
        _robots_cache[raiz] = rp
    rp = _robots_cache[raiz]
    if rp is None:
        return True
    try:
        return rp.can_fetch(UA, url)
    except Exception:
        return True


def _paragrafos(html_bruto):
    """Extrai os paragrafos do texto principal.

    O pulo do gato e o ESCOPO: paginas de noticia costumam ter varios <article>
    na mesma pagina (os cards de 'leia tambem' tambem sao <article>). Pegar o
    primeiro trazia a materia errada - a Revista Apolice devolvia um card da
    Mapfre no lugar da noticia. Entao testamos cada bloco candidato e ficamos
    com o que tem MAIS texto, que e sempre a materia de verdade."""
    limpo = re.sub(r"(?is)<(script|style|nav|aside|footer|header|form|figure|noscript)\b.*?</\1>",
                   " ", html_bruto)

    def extrair(escopo):
        saida = []
        for p in re.findall(r"(?is)<p[^>]*>(.*?)</p>", escopo):
            t = html.unescape(re.sub(r"(?s)<[^>]+>", " ", p))
            t = re.sub(r"\s+", " ", t).strip()
            # frase curta quase sempre e legenda de foto, credito ou botao
            if len(t) > 60:
                saida.append(t)
        return saida

    candidatos = re.findall(r"(?is)<article[^>]*>(.*?)</article>", limpo)
    candidatos += re.findall(
        r'(?is)<div[^>]*class="[^"]*(?:entry-content|post-content|article-body|'
        r'td-post-content|content-inner|post-body|theme-post-content)[^"]*"[^>]*>(.*?)</div>',
        limpo)

    melhor = []
    for c in candidatos:
        ps = extrair(c)
        if sum(len(x) for x in ps) > sum(len(x) for x in melhor):
            melhor = ps

    # nenhum bloco convincente? cai pra pagina inteira - vem com alguma sujeira,
    # mas e melhor que frase cortada no meio
    if len(melhor) < 2 or sum(len(x) for x in melhor) < 400:
        melhor = extrair(limpo)
    return melhor


def buscar_corpo(link):
    """Abre a materia e devolve (paragrafos, tem_paywall).
    Devolve (None, False) sempre que nao der - o chamador fica com o RSS."""
    if not link:
        return None, False

    # Link do Google News nao leva direto na materia: e um token que so o
    # JavaScript deles resolve. Nem tenta - esses itens ficam marcados
    # "so RSS" mesmo, que e honesto.
    if "news.google.com" in link:
        return None, False

    if not robots_permite(link):
        return None, False

    try:
        pagina = baixar(link, timeout=TIMEOUT_ARTIGO)
    except Exception:
        return None, False

    paywall = any(m in sem_acento(pagina) for m in MARCAS_PAYWALL)
    ps = _paragrafos(pagina)
    if not ps:
        return None, paywall
    return ps[:MAX_PARAGRAFOS], paywall


def normalizar_link(link):
    """Tira rastreadores (utm_*, fbclid) e barra final - a mesma noticia
    compartilhada em lugares diferentes vira o mesmo link."""
    if not link:
        return ""
    try:
        p = urllib.parse.urlsplit(link.strip())
        q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
             if not k.lower().startswith(("utm_", "fbclid", "gclid", "ref"))]
        caminho = p.path.rstrip("/") or "/"
        return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), caminho,
                                        urllib.parse.urlencode(q), ""))
    except Exception:
        return link.strip()


def hash_item(link, titulo):
    """Impressao digital da noticia: link normalizado + titulo sem acento."""
    base = normalizar_link(link) + "|" + re.sub(r"\W+", "", sem_acento(titulo))[:80]
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


def limpar_titulo(t):
    """O Google News gruda ' - Veiculo' no fim do titulo. Isso polui a leitura
    e, pior, quebra a deduplicacao: a mesma noticia em dois sites vira dois
    titulos diferentes so por causa do sufixo.
    Devolve (titulo_limpo, veiculo) - o veiculo extraido daqui e o jornal DE
    VERDADE, melhor que o nome interno da fonte agregadora."""
    if not t:
        return "", ""
    veic = ""
    m = re.search(r"\s*\|\s*([^|]{2,60})$", t)
    if m:
        veic = m.group(1).strip()
        t = t[:m.start()]
    m = re.search(r"\s+-\s+([^-]{2,40})$", t)
    if m:
        veic = m.group(1).strip() or veic
        t = t[:m.start()]
    return t.strip(" -|·"), veic.strip(" .,")


def limpar_html(texto):
    if not texto:
        return ""
    texto = re.sub(r"(?is)<(script|style).*?</\1>", " ", texto)
    texto = re.sub(r"(?s)<[^>]+>", " ", texto)
    texto = html.unescape(texto)
    texto = re.sub(r"\s+", " ", texto).strip()

    # Rodape que o WordPress cola no fim de todo item de RSS. Nao e noticia:
    # era lido em voz alta no fim de cada bloco ("The post first appeared on
    # CQCS ponto") e entrava nos bullets do boletim escrito.
    # A versao em portugues ("O post apareceu primeiro em...") vem dos plugins
    # traduzidos - por isso as duas linguas.
    rodapes = [
        r"\bThe post\b.*?\b(?:first appeared on|appeared first on)\b.*$",
        r"\bO post\b.*?\bapareceu primeiro em\b.*$",
        r"\bEsse post\b.*?\bapareceu primeiro em\b.*$",
        r"\b(?:Read More|Leia mais|Continue lendo|Saiba mais)\s*[.…»>]*\s*$",
    ]
    for r in rodapes:
        texto = re.sub(r, "", texto, flags=re.I)

    # "[...]" e o corte do proprio feed - vira reticencia de verdade
    texto = texto.replace("[…]", "...").replace("[...]", "...")
    return re.sub(r"\s+", " ", texto).strip(" .,;-") or ""


def parse_data(s):
    """Aceita data de RSS (RFC 822) e de Atom (ISO 8601)."""
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        pass
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        return None


# ─────────────────────── leitura de feed ───────────────────────

def _tag(el):
    """Nome da tag sem o namespace (Atom usa namespace, RSS nao)."""
    return el.tag.split("}")[-1] if "}" in el.tag else el.tag


def parse_feed(xml_text):
    """Le RSS 2.0 ou Atom e devolve lista de itens padronizados."""
    xml_text = xml_text.lstrip("﻿ \n\r\t")
    raiz = ET.fromstring(xml_text)
    itens = []

    nos = [e for e in raiz.iter() if _tag(e) in ("item", "entry")]
    for n in nos:
        campos = {}
        for filho in n:
            t = _tag(filho)
            if t == "link":
                # Atom poe a URL no atributo href; RSS poe no texto
                href = filho.attrib.get("href")
                if href and filho.attrib.get("rel", "alternate") == "alternate":
                    campos.setdefault("link", href)
                elif (filho.text or "").strip():
                    campos.setdefault("link", filho.text.strip())
            elif t in ("title", "pubDate", "published", "updated", "author",
                       "description", "summary", "content", "encoded", "creator", "source"):
                valor = "".join(filho.itertext()).strip()
                if t == "author":
                    valor = valor or "".join(x.text or "" for x in filho)
                if valor:
                    campos.setdefault(t, valor)

        titulo, veic_titulo = limpar_titulo(limpar_html(campos.get("title", "")))
        link = campos.get("link", "")
        if not titulo or not link:
            continue

        data = (parse_data(campos.get("pubDate"))
                or parse_data(campos.get("published"))
                or parse_data(campos.get("updated")))

        resumo = limpar_html(campos.get("description")
                             or campos.get("summary")
                             or campos.get("content")
                             or campos.get("encoded") or "")

        itens.append({
            "titulo": titulo,
            "link": link,
            "data": data,
            "autor": limpar_html(campos.get("author") or campos.get("creator") or ""),
            "resumo": resumo[:1200],
            # de onde a materia saiu de verdade (o RSS traz em <source>, ou vem
            # do sufixo do titulo). Usado no lugar do nome interno da fonte.
            "veiculo_real": limpar_html(campos.get("source") or "") or veic_titulo,
        })
    return itens


CAMINHOS_FEED = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml",
                 "/index.xml", "/feeds/posts/default", "/blog/rss", "/feed/"]


def descobrir_feed(url):
    """Dada a URL de um site, acha o feed. Devolve (feed_url, como_achou) ou (None, motivo)."""
    url = url.strip()
    if not url.startswith("http"):
        url = "https://" + url

    # 1) a propria URL ja e um feed?
    try:
        txt = baixar(url)
        if "<rss" in txt[:2000].lower() or "<feed" in txt[:2000].lower():
            return url, "a URL ja era um feed"
    except Exception:
        txt = None

    # 2) o HTML declara o feed? (<link rel="alternate" type="application/rss+xml">)
    if txt:
        for m in re.finditer(r'(?is)<link[^>]+>', txt):
            tag = m.group(0)
            if "alternate" in tag.lower() and ("rss+xml" in tag.lower() or "atom+xml" in tag.lower()):
                href = re.search(r'href=["\']([^"\']+)["\']', tag, re.I)
                if href:
                    return urllib.parse.urljoin(url, href.group(1)), "declarado no HTML do site"

    # 3) tenta os caminhos comuns
    p = urllib.parse.urlsplit(url)
    raiz = f"{p.scheme}://{p.netloc}"
    for c in CAMINHOS_FEED:
        tentativa = raiz + c
        try:
            t = baixar(tentativa, timeout=8)
            if "<rss" in t[:2000].lower() or "<feed" in t[:2000].lower():
                return tentativa, f"encontrado em {c}"
        except Exception:
            continue

    return None, "nao achei feed RSS/Atom nesse site"


def validar_feed(feed_url):
    """Um feed so entra se baixa, e XML valido, e tem item recente com titulo/link/data."""
    try:
        txt = baixar(feed_url)
    except Exception as e:
        return {"ok": False, "motivo": f"nao baixou ({type(e).__name__})"}
    try:
        itens = parse_feed(txt)
    except ET.ParseError as e:
        return {"ok": False, "motivo": f"XML invalido ({e})"}
    if not itens:
        return {"ok": False, "motivo": "feed sem itens"}

    com_data = [i for i in itens if i["data"]]
    if not com_data:
        return {"ok": False, "motivo": "itens sem data de publicacao"}

    mais_novo = max(i["data"] for i in com_data)
    idade_dias = (datetime.now(timezone.utc) - mais_novo).days
    if idade_dias > 7:
        return {"ok": False, "motivo": f"feed parado ha {idade_dias} dias"}

    return {"ok": True, "itens": len(itens), "idade_dias": idade_dias,
            "titulos": [i["titulo"] for i in itens[:3]]}


# ─────────────────────────── histórico ───────────────────────────

def abrir_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS itens(
        hash TEXT PRIMARY KEY, link TEXT, titulo TEXT, veiculo TEXT,
        data_pub TEXT, data_coleta TEXT, score INTEGER, usado INTEGER DEFAULT 0)""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_coleta ON itens(data_coleta)")
    con.commit()
    return con


def ja_visto(con, h):
    return con.execute("SELECT 1 FROM itens WHERE hash=?", (h,)).fetchone() is not None


# ──────────────────────────── pontuação ───────────────────────────

def pontuar(item, cfg, fonte):
    """0 a 100, seguindo a regra da Fase 4 do projeto."""
    t = sem_acento(item["titulo"] + " " + item["resumo"])
    score = 0
    motivos = []

    # +40 relevancia pro nicho e palavras-chave
    chaves = [sem_acento(k) for k in cfg.get("palavras_chave", [])]
    batidas = sum(1 for k in chaves if k and k in t)
    if batidas:
        pts = min(40, 14 + batidas * 9)
        score += pts
        motivos.append(f"+{pts} bate com {batidas} palavra(s)-chave")

    # +20 nota da fonte (0-10 -> 0-20)
    pts = int(fonte.get("nota", 5)) * 2
    score += pts
    motivos.append(f"+{pts} nota da fonte")

    # +15 ineditismo (fonte primaria/oficial vale mais)
    if fonte.get("tipo") in ("oficial", "primaria"):
        score += 15
        motivos.append("+15 fonte primaria/oficial")
    elif fonte.get("tipo") == "especializada":
        score += 8
        motivos.append("+8 imprensa especializada")

    # +15 impacto: mexe com dinheiro, lei ou tecnologia central
    impacto = ["bilhao", "milhao", "tarifa", "leilao", "lei ", "medida provisoria",
               "regulament", "aneel", "susep", "resolucao", "consulta publica",
               "reajuste", "aliquota", "imposto", "multa", "sinistro"]
    if any(p in t for p in impacto):
        score += 15
        motivos.append("+15 impacto (dinheiro/lei)")

    # +10 frescor
    if item["data"]:
        horas = (datetime.now(timezone.utc) - item["data"]).total_seconds() / 3600
        if horas <= 6:
            score += 10; motivos.append("+10 saiu ha poucas horas")
        elif horas <= 12:
            score += 6; motivos.append("+6 saiu hoje")
        elif horas <= 24:
            score += 3; motivos.append("+3 ultimas 24h")

    # +8 o feed entregou texto de verdade, nao so a manchete.
    # Sem isso os agregadores (que so dao titulo) afogam as fontes nativas,
    # e o boletim inteiro vira uma lista de manchetes sem substancia.
    t_norm = re.sub(r"\W+", "", sem_acento(item["titulo"]))[:60]
    corpo = re.sub(r"\W+", "", sem_acento(item["resumo"]))
    if len(corpo) > len(t_norm) + 120:
        score += 18
        motivos.append("+18 o feed trouxe o texto")
    elif len(corpo) <= len(t_norm) + 20:
        # Manchete pelada, sem uma linha de texto. Quase sempre e agregador
        # (Google News) repetindo o que outra fonte ja publicou - e a Fase 2.4
        # manda descartar agregador que so repete. So o bonus de texto nao
        # bastava: item de fonte "oficial" carrega +20 de nota e +15 de tipo,
        # entao subia no ranking mesmo sem trazer nada para ler.
        score -= 15
        motivos.append("-15 so a manchete, sem texto no feed")

    # -30 clickbait / listicle / release disfarcado
    lixo = ["top 10", "os melhores", "voce nao vai acreditar", "veja o que",
            "confira", "saiba mais", "patrocinado", "publieditorial", "conteudo de marca"]
    if any(p in t for p in lixo):
        score -= 30
        motivos.append("-30 cara de clickbait/publi")

    return max(0, min(100, score)), motivos


# Marcas de conteudo pago que os veiculos usam mesmo sem dizer "patrocinado".
# Ficam separadas dos "bloqueios" do config porque nao sao gosto pessoal:
# publi disfarcada de materia nunca deve entrar, independente do nicho.
MARCAS_DE_PUBLI = [
    "conteudo de marca", "conteudo oferecido", "oferecido pela", "oferecido por",
    "publieditorial", "publi editorial", "branded content", "informe publicitario",
    "espaco do patrocinador", "conteudo patrocinado",
]


def bloqueado(item, cfg):
    # O LINK entra na conferencia junto com o texto: o MegaWhat, por exemplo,
    # publica publi em /conteudo-de-marca/ sem escrever isso no titulo nem no
    # resumo - olhando so o texto, a materia paga passava batida.
    # Os hifens da URL viram espaco pra "conteudo-de-marca" casar com o termo.
    link_texto = sem_acento(item.get("link", "")).replace("-", " ").replace("/", " ")
    t = sem_acento(item["titulo"] + " " + item["resumo"]) + " " + link_texto

    for b in cfg.get("bloqueios", []):
        if sem_acento(b) in t:
            return b
    for m in MARCAS_DE_PUBLI:
        if m in t:
            return m
    return None


# ──────────────────────── texto para a voz ────────────────────────

UNI = ["zero","um","dois","tres","quatro","cinco","seis","sete","oito","nove","dez",
       "onze","doze","treze","quatorze","quinze","dezesseis","dezessete","dezoito","dezenove"]
DEZ = ["","","vinte","trinta","quarenta","cinquenta","sessenta","setenta","oitenta","noventa"]
CEM = ["","cento","duzentos","trezentos","quatrocentos","quinhentos",
       "seiscentos","setecentos","oitocentos","novecentos"]


def numero_extenso(n):
    """Numero inteiro por extenso, ate 999.999 - suficiente pra boletim."""
    n = int(n)
    if n < 20:
        return UNI[n]
    if n < 100:
        d, r = divmod(n, 10)
        return DEZ[d] + (" e " + UNI[r] if r else "")
    if n == 100:
        return "cem"
    if n < 1000:
        c, r = divmod(n, 100)
        return CEM[c] + (" e " + numero_extenso(r) if r else "")
    if n < 1000000:
        m, r = divmod(n, 1000)
        pre = "mil" if m == 1 else numero_extenso(m) + " mil"
        return pre + (" e " + numero_extenso(r) if r else "")
    return str(n)


def falar_numeros(texto):
    """Transforma numero em fala: 30% -> trinta por cento; R$ 1,2 bilhao -> um virgula dois bilhao de reais."""
    def dec(m):
        inteiro, frac = m.group(1), m.group(2)
        return f"{numero_extenso(inteiro)} virgula {' '.join(numero_extenso(d) for d in frac)}"

    # data ANTES de tudo: senao "02/08" viraria "dois barra oito" / "dois/oito"
    def data_falada(m):
        d, mes = int(m.group(1)), int(m.group(2))
        if 1 <= mes <= 12 and 1 <= d <= 31:
            return f"{numero_extenso(d)} de {MESES[mes]}"
        return m.group(0)
    texto = re.sub(r"\b(\d{1,2})/(\d{1,2})(?!/?\d)", data_falada, texto)

    # R$ 1,2 bilhao / R$ 350 milhoes
    texto = re.sub(r"R\$\s*(\d+),(\d)\s*(bilh|milh)(\w*)",
                   lambda m: f"{numero_extenso(m.group(1))} virgula {numero_extenso(m.group(2))} "
                             f"{'bilhoes' if m.group(3)=='bilh' else 'milhoes'} de reais", texto)
    texto = re.sub(r"R\$\s*(\d+)\s*(bilh|milh)(\w*)",
                   lambda m: f"{numero_extenso(m.group(1))} "
                             f"{'bilhoes' if m.group(2)=='bilh' else 'milhoes'} de reais", texto)
    texto = re.sub(r"R\$\s*(\d+)", lambda m: numero_extenso(m.group(1)) + " reais", texto)
    # porcentagem, inclusive com decimal
    texto = re.sub(r"(\d+),(\d+)\s*%", lambda m: dec(m) + " por cento", texto)
    texto = re.sub(r"(\d+)\s*%", lambda m: numero_extenso(m.group(1)) + " por cento", texto)
    # numeros soltos ate 4 digitos (ano fica como esta pra nao ficar esquisito)
    texto = re.sub(r"\b(\d{1,3})\b", lambda m: numero_extenso(m.group(1)), texto)
    return texto


SIGLAS = {"IA": "i-a", "TI": "te-i", "PIB": "pib", "ANEEL": "a-nel", "SUSEP": "su-sep",
          "CCEE": "cê-cê-e-e", "ONS": "o-ene-esse", "MME": "eme-eme-e",
          "CNseg": "cê-ene-seg", "ESG": "e-esse-gê", "GD": "gê-dê"}


def limpar_para_voz(texto):
    """Tira tudo que nao se le em voz alta: URL, markdown, emoji, colchete."""
    texto = re.sub(r"https?://\S+", "", texto)          # URLs
    texto = re.sub(r"[#*_`>|]+", " ", texto)             # markdown
    texto = re.sub(r"\[[^\]]*\]\([^)]*\)", " ", texto)   # links markdown
    texto = re.sub(r"[\[\]{}]", " ", texto)              # colchetes
    texto = "".join(c for c in texto if ord(c) < 0x2190) # emoji e simbolos
    texto = re.sub(r"\bbullet\b", "", texto, flags=re.I)
    for s, f in SIGLAS.items():
        texto = re.sub(rf"\b{s}\b", f, texto)
    texto = falar_numeros(texto)
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return texto.strip()


# ──────────────────────────── coleta ────────────────────────────

def coletar(cfg, fontes, arq_log):
    janela = timedelta(hours=cfg.get("janela_horas", 24))
    agora = datetime.now(timezone.utc)
    con = abrir_db()

    vistos = novos = 0
    falhas = []
    candidatos = []

    ativas = [f for f in fontes if f.get("ativo", True)]
    log(f"Consultando {len(ativas)} fonte(s)...", arq_log)

    for f in ativas:
        try:
            txt = baixar(f["feed"])
            itens = parse_feed(txt)
        except Exception as e:
            falhas.append((f["nome"], f"{type(e).__name__}"))
            log(f"  FALHOU: {f['nome']} - {type(e).__name__}", arq_log)
            continue

        entraram = 0
        for it in itens:
            vistos += 1
            if not it["data"] or (agora - it["data"]) > janela:
                continue
            b = bloqueado(it, cfg)
            if b:
                continue
            h = hash_item(it["link"], it["titulo"])
            if ja_visto(con, h):
                continue

            score, motivos = pontuar(it, cfg, f)
            # prefere o jornal de verdade; cai pro nome da fonte se nao souber
            veic = it.get("veiculo_real") or f["nome"]
            it.update({"hash": h, "veiculo": veic, "fonte": f["nome"],
                       "tipo_fonte": f.get("tipo", ""),
                       "score": score, "motivos": motivos})
            candidatos.append(it)
            novos += 1
            entraram += 1
        log(f"  {f['nome']}: {entraram} novo(s) na janela", arq_log)

    # dedup entre veiculos: mesma noticia em varios lugares vira uma so
    candidatos.sort(key=lambda x: -x["score"])
    final, tambem_em = [], {}
    for c in candidatos:
        chave = re.sub(r"\W+", "", sem_acento(c["titulo"]))[:60]
        dup = next((x for x in final if re.sub(r"\W+", "", sem_acento(x["titulo"]))[:60] == chave), None)
        if dup:
            tambem_em.setdefault(dup["hash"], []).append(c["veiculo"])
        else:
            final.append(c)
    for x in final:
        x["tambem_em"] = tambem_em.get(x["hash"], [])

    # grava TUDO no historico (mesmo o que nao entrou no boletim)
    for c in candidatos:
        con.execute("INSERT OR IGNORE INTO itens VALUES (?,?,?,?,?,?,?,0)",
                    (c["hash"], c["link"], c["titulo"], c["veiculo"],
                     c["data"].isoformat() if c["data"] else "",
                     agora.isoformat(), c["score"]))
    con.commit()

    n_princ = cfg.get("artigos_principais", 5)
    n_radar = cfg.get("artigos_radar", 2)
    escolhidos = final[: n_princ + n_radar]
    for c in escolhidos:
        con.execute("UPDATE itens SET usado=1 WHERE hash=?", (c["hash"],))
    con.commit()
    con.close()

    log(f"Vistos: {vistos} | novos na janela: {novos} | escolhidos: {len(escolhidos)} | falhas: {len(falhas)}", arq_log)
    return escolhidos, {"vistos": vistos, "novos": novos, "falhas": falhas,
                        "fontes": len(ativas), "n_princ": n_princ}


# ──────────────────────── geração do boletim ────────────────────────

MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
         "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo"]


def bullets_do_resumo(item, n=5):
    """Monta os bullets a partir do que o proprio RSS entregou.
    NAO inventa nada. Se o feed so repetiu o titulo (o Google News faz isso),
    assume que nao ha resumo em vez de fingir que o titulo e conteudo."""
    # se a camada editorial (modo "ia") escreveu, ela tem prioridade
    ed = item.get("editorial")
    if ed and ed.get("bullets"):
        return ed["bullets"][:n], False

    # corpo aberto na materia: e o texto completo, entao nao ha o que cortar.
    # Cada paragrafo vira um bullet, ja em frase inteira - era exatamente isso
    # que faltava quando o RSS entregava "...a proposta visa enfrentar" e parava.
    corpo = item.get("corpo")
    if corpo:
        return corpo[:n], False

    txt = item["resumo"] or ""

    # tira do resumo o que for so repeticao do titulo
    t_norm = re.sub(r"\W+", "", sem_acento(item["titulo"]))
    sobra = re.sub(r"\W+", "", sem_acento(txt))
    if t_norm and t_norm[:60] in sobra:
        sobra_txt = re.sub(re.escape(item["titulo"]), "", txt, flags=re.I).strip(" -|·")
    else:
        sobra_txt = txt

    if len(sobra_txt) < 60:
        return (["O feed traz só a manchete — este resumo é baseado apenas no RSS. "
                 "Abra o link para ler a matéria."], True)

    frases = [f.strip() for f in re.split(r"(?<=[.!?])\s+", sobra_txt) if len(f.strip()) > 25]
    if not frases:
        return ([sobra_txt[:300]], True)
    return frases[:n], False


def avisos_de_continuidade(cfg):
    """Detecta buraco na serie: PC desligado no horario (dias sem boletim) ou
    rodadas seguidas que nao trouxeram nada. Sem isso o boletim mente por
    omissao - parece um dia normal quando na verdade voce ficou dias no escuro."""
    avisos = []
    hoje_str = datetime.now().strftime("%Y-%m-%d")
    try:
        dias = sorted(d for d in os.listdir(BOLETINS)
                      if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) and d != hoje_str)
    except FileNotFoundError:
        return avisos

    if dias:
        ultimo = datetime.strptime(dias[-1], "%Y-%m-%d")
        gap = (datetime.now().date() - ultimo.date()).days
        if gap >= 2:
            avisos.append(f"Boletim atrasado: o radar não rodava desde {ultimo.strftime('%d/%m')} "
                          f"({gap} dias). Costuma ser o PC desligado no horário.")

    # duas ultimas rodadas sem nada = alguma coisa esta errada (fonte morta,
    # internet, palavra-chave errada) e o usuario precisa saber
    vazios = 0
    for d in reversed(dias[-2:]):
        md = os.path.join(BOLETINS, d, "boletim.md")
        try:
            if "Nenhuma notícia nova" in open(md, encoding="utf-8").read():
                vazios += 1
            else:
                break
        except Exception:
            break
    if vazios >= 2:
        avisos.append("As duas últimas rodadas não trouxeram nada. "
                      "Vale rodar 'radar fontes' e conferir se algum feed morreu.")
    return avisos


def gerar_boletim(escolhidos, stats, cfg, pasta, arq_log=None):
    hoje = datetime.now()

    # ---------- abre as materias escolhidas ----------
    # Feito ANTES da camada editorial de proposito: quando o modo "ia" esta
    # ligado, ela passa a resumir a materia inteira em vez das 55 palavras
    # truncadas do RSS. E so para as 7 escolhidas - abrir as ~300 varridas
    # seria abuso com os sites e levaria minutos.
    if cfg.get("abrir_materia", True):
        abertas = paywalls = 0
        for it in escolhidos:
            ps, pw = buscar_corpo(it.get("link", ""))
            it["paywall"] = pw
            if ps:
                it["corpo"] = ps
                abertas += 1
                if pw:
                    paywalls += 1
        log(f"Materias abertas: {abertas}/{len(escolhidos)}"
            + (f" ({paywalls} com paywall - resumo parcial)" if paywalls else ""), arq_log)

    # camada editorial opcional (config.json -> resumo.modo = "ia").
    # Se nao estiver ligada, ou falhar, cai no modo local sem drama.
    editorial = None
    try:
        import resumir
        editorial = resumir.resumir(escolhidos, cfg, log=lambda m: log(m, arq_log))
    except Exception as e:
        log(f"  [ia] camada indisponivel ({type(e).__name__}) - modo local", arq_log)
    for n, it in enumerate(escolhidos, 1):
        it["editorial"] = (editorial or {}).get(n)
    data_ext = f"{hoje.day} de {MESES[hoje.month]} de {hoje.year}"
    dia_sem = DIAS[hoje.weekday()]
    n_princ = stats["n_princ"]

    # ---------- Markdown ----------
    md = [f"# Radar de {cfg['nicho']}",
          f"**{dia_sem}, {data_ext}**", "",
          f"{stats['fontes']} fontes consultadas · {stats['vistos']} itens varridos · "
          f"{stats['novos']} novos na janela de {cfg['janela_horas']}h · {len(escolhidos)} selecionados"]
    avisos = avisos_de_continuidade(cfg)
    for a in avisos:
        md.append("")
        md.append(f"> ⚠ {a}")
    if stats["falhas"]:
        md.append("")
        md.append("> Fontes indisponíveis hoje: " +
                  ", ".join(f"{n} ({m})" for n, m in stats["falhas"]))
    md.append("")

    if not escolhidos:
        md.append("_Nenhuma notícia nova dentro da janela. Isso costuma ser normal em fim de semana e feriado._")

    for i, it in enumerate(escolhidos, 1):
        if i == n_princ + 1:
            md.append("\n---\n\n## Radar secundário\n")
        bullets, so_rss = bullets_do_resumo(it)
        data_txt = it["data"].astimezone().strftime("%d/%m") if it["data"] else "sem data"
        # o tempo de leitura tem que sair do texto que o leitor vai ver;
        # calculado so pelo resumo do RSS, dava "1 min" para toda materia
        base_leitura = " ".join(it.get("corpo") or []) or it["resumo"]
        leitura = max(1, len(base_leitura.split()) // 200)
        marca = "só RSS" if so_rss else "fato"
        if it.get("paywall"):
            marca = "paywall — resumo parcial, só o trecho público"
        md.append(f"### [{i}] {it['titulo']}")
        md.append(f"{it['veiculo']} · {data_txt} · leitura ~{leitura} min · [{marca}]")
        md.append("")
        md.append("**O que aconteceu:**")
        for b in bullets:
            md.append(f"- {b}")
        md.append("")
        ed = it.get("editorial")
        if ed and ed.get("importa"):
            md.append(f"**Por que isso importa:** {ed['importa']}")
            md.append("")
        if ed and ed.get("angulo"):
            md.append(f"**Ângulo pra usar:** {ed['angulo']}")
            md.append("")
        if it["motivos"]:
            md.append(f"**Por que entrou:** {'; '.join(it['motivos'][:3])} (score {it['score']}/100)")
            md.append("")
        md.append(f"**Link:** {it['link']}")
        if it["tambem_em"]:
            md.append(f"**Também em:** {', '.join(sorted(set(it['tambem_em'])))}")
        md.append("")

    if escolhidos:
        veics = sorted({x["veiculo"] for x in escolhidos})
        md += ["---", "", "## Conexões do dia", "",
               f"- O dia foi puxado por {veics[0]}" +
               (f" e {veics[1]}" if len(veics) > 1 else "") + ".",
               f"- {len(escolhidos)} notícias passaram no corte de {stats['novos']} candidatas.",
               "- Os itens de fonte oficial pesam mais no ranking: costumam virar regra depois.",
               "", "## O que observar amanhã", "",
               "- Se algum tema de hoje ganhar desdobramento em fonte oficial.",
               "- Fontes que falharam hoje podem trazer atraso amanhã.", ""]

    md.append(f"\n_Gerado automaticamente em {hoje.strftime('%d/%m/%Y %H:%M')} — sem API paga, sem chave._")
    caminho_md = os.path.join(pasta, "boletim.md")
    open(caminho_md, "w", encoding="utf-8").write("\n".join(md))

    # ---------- HTML ----------
    def esc(s):
        return html.escape(s or "")
    linhas_html = []
    for i, it in enumerate(escolhidos, 1):
        bullets, _ = bullets_do_resumo(it)
        data_txt = it["data"].astimezone().strftime("%d/%m") if it["data"] else "sem data"
        linhas_html.append(f"""
      <article>
        <h3><span class="num">{i}</span> {esc(it['titulo'])}</h3>
        <div class="meta">{esc(it['veiculo'])} · {data_txt} · score {it['score']}/100</div>
        <ul>{''.join(f'<li>{esc(b)}</li>' for b in bullets)}</ul>
        <a href="{esc(it['link'])}" target="_blank" rel="noopener">abrir matéria &rarr;</a>
        {f'<div class="tambem">também em: {esc(", ".join(sorted(set(it["tambem_em"]))))}</div>' if it['tambem_em'] else ''}
      </article>""")

    html_doc = f"""<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Radar — {esc(data_ext)}</title><style>
:root{{--bg:#0d1117;--card:#161b22;--b:#30363d;--txt:#e6edf3;--dim:#8b949e;--ac:#4ea1ff}}
*{{box-sizing:border-box}}
body{{margin:0;padding:24px 16px;background:var(--bg);color:var(--txt);
font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}}
.wrap{{max-width:760px;margin:0 auto}}
h1{{font-size:1.5rem;margin:0 0 4px}} .sub{{color:var(--dim);font-size:.85rem;margin-bottom:24px}}
article{{background:var(--card);border:1px solid var(--b);border-radius:12px;padding:18px;margin-bottom:16px}}
h3{{margin:0 0 6px;font-size:1.05rem;line-height:1.4}}
.num{{color:var(--ac);font-weight:700}}
.meta{{color:var(--dim);font-size:.78rem;margin-bottom:10px}}
ul{{margin:0 0 12px;padding-left:20px}} li{{margin-bottom:6px;font-size:.92rem}}
a{{color:var(--ac);text-decoration:none;font-size:.88rem}} a:hover{{text-decoration:underline}}
.tambem{{color:var(--dim);font-size:.78rem;margin-top:8px}}
.falhas{{background:#3a2a12;border:1px solid #6b4a1a;padding:10px 14px;border-radius:8px;
font-size:.82rem;margin-bottom:20px}}
footer{{color:var(--dim);font-size:.75rem;margin-top:28px;text-align:center}}
</style></head><body><div class="wrap">
<h1>Radar de {esc(cfg['nicho'])}</h1>
<div class="sub">{esc(dia_sem)}, {esc(data_ext)} — {stats['fontes']} fontes · {stats['vistos']} itens varridos · {len(escolhidos)} selecionados</div>
{'<div class="falhas">Fontes indisponíveis hoje: ' + esc(", ".join(n for n,_ in stats["falhas"])) + '</div>' if stats['falhas'] else ''}
{''.join(linhas_html) if escolhidos else '<p>Nenhuma notícia nova dentro da janela.</p>'}
<footer>Gerado em {hoje.strftime('%d/%m/%Y %H:%M')} · sem API paga, sem chave</footer>
</div></body></html>"""
    open(os.path.join(pasta, "boletim.html"), "w", encoding="utf-8").write(html_doc)

    # ---------- roteiro do áudio ----------
    r = [f"{cfg.get('abertura','Bom dia. Aqui e o seu radar.')} "
         f"Hoje e {dia_sem}, {data_ext}."]
    for a in avisos:
        r.append("Aviso: " + a)
    if escolhidos:
        manchetes = [x["titulo"] for x in escolhidos[:3]]
        r.append("Hoje: " + ". ".join(manchetes) + ".")
        r.append("")
        for i, it in enumerate(escolhidos, 1):
            if i == 1:
                r.append("Vamos comecar.")
            elif i == len(escolhidos):
                r.append("Pra fechar.")
            else:
                r.append("Proxima.")
            # Agora que a materia vem aberta, cada bullet e um paragrafo inteiro
            # e nao mais uma linha do RSS - por isso o radar secundario leva 2
            # em vez de 3. Sem esse ajuste o boletim narrado passava dos 6 min
            # que sao o teto do alvo.
            bullets, so_rss = bullets_do_resumo(it, 3 if i <= n_princ else 2)
            r.append(f"Segundo o {it['veiculo']}: {it['titulo']}.")
            if so_rss:
                # o feed nao trouxe corpo: avisa UMA vez so, sem repetir o aviso
                r.append("O detalhe completo esta no link do boletim escrito.")
            else:
                for b in bullets:
                    r.append(b)
            ed = it.get("editorial")
            if ed and ed.get("importa"):
                r.append(f"Por que isso importa: {ed['importa']}")
            if ed and ed.get("angulo"):
                r.append(f"Angulo pra usar: {ed['angulo']}")
            r.append("")
        r.append("Conexoes do dia. "
                 f"Foram {len(escolhidos)} noticias selecionadas de {stats['novos']} candidatas. "
                 "As de fonte oficial pesam mais, porque costumam virar regra depois.")
        r.append("")
    else:
        r.append("Hoje nao entrou nenhuma noticia nova dentro da janela. "
                 "Isso costuma acontecer em fim de semana e feriado.")
        r.append("")
    r.append(cfg.get("encerramento", "Isso e tudo."))

    roteiro = limpar_para_voz("\n".join(r))
    open(os.path.join(pasta, "roteiro-audio.txt"), "w", encoding="utf-8").write(roteiro)

    palavras = len(roteiro.split())
    return caminho_md, palavras


# ──────────────────────────── principal ────────────────────────────

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "coletar"

    if cmd == "descobrir":
        feed, como = descobrir_feed(sys.argv[2])
        print(json.dumps({"feed": feed, "como": como}, ensure_ascii=False))
        return

    if cmd == "validar":
        print(json.dumps(validar_feed(sys.argv[2]), ensure_ascii=False, default=str))
        return

    cfg = json.load(open(CONFIG_PATH, encoding="utf-8"))
    if not os.path.exists(FONTES_PATH):
        print("ERRO: fontes.json nao existe. Rode 'radar +fonte <url>' pra adicionar fontes.")
        sys.exit(1)
    fontes = json.load(open(FONTES_PATH, encoding="utf-8"))["fontes"]

    hoje = datetime.now().strftime("%Y-%m-%d")
    pasta = os.path.join(BOLETINS, hoje)
    os.makedirs(pasta, exist_ok=True)
    os.makedirs(LOGS, exist_ok=True)
    arq_log = os.path.join(LOGS, f"{hoje}.log")

    # sem internet: avisa em vez de gerar boletim vazio mentindo
    try:
        baixar("https://news.google.com/rss?hl=pt-BR", timeout=8)
    except Exception:
        log("SEM INTERNET - nao da pra montar o boletim agora.", arq_log)
        print("\n>> Sem conexao com a internet. Tente de novo quando voltar.")
        sys.exit(2)

    log(f"=== Radar {hoje} ===", arq_log)
    escolhidos, stats = coletar(cfg, fontes, arq_log)
    caminho, palavras = gerar_boletim(escolhidos, stats, cfg, pasta, arq_log)
    log(f"Boletim gerado: {caminho} (~{palavras} palavras de roteiro)", arq_log)

    # ---- prova de vida pro painel de agentes do Jarvis ----
    # O Jarvis le esses arquivos pra saber se o radar rodou. Se a pasta dele
    # nao existir (usuario sem Jarvis), simplesmente ignora e segue.
    try:
        escrever_estado_jarvis(escolhidos, stats, pasta)
    except Exception as e:
        log(f"(nao consegui avisar o Jarvis: {type(e).__name__})", arq_log)

    print(json.dumps({
        "ok": True, "pasta": pasta, "selecionados": len(escolhidos),
        "vistos": stats["vistos"], "novos": stats["novos"],
        "falhas": [n for n, _ in stats["falhas"]], "palavras_roteiro": palavras
    }, ensure_ascii=False))


# pastas onde o Jarvis pode estar instalado - a primeira que existir vence
JARVIS_POSSIVEIS = [
    r"D:\8 - Claude - projeto\Jarvis",
    r"D:\Claude - projeto\Jarvis",
    os.path.join(os.path.expanduser("~"), "Jarvis"),
]


def achar_jarvis():
    for p in JARVIS_POSSIVEIS:
        if os.path.isdir(os.path.join(p, "agent-state")):
            return p
    return None


def escrever_estado_jarvis(escolhidos, stats, pasta):
    """Grava o estado do radar no formato que o painel de agentes do Jarvis le,
    e tambem um resumo do boletim pro Jarvis poder mostrar/falar."""
    jarvis = achar_jarvis()
    if not jarvis:
        return
    destino = os.path.join(jarvis, "agent-state")

    # 1) prova de vida (mesmo formato dos outros agentes do Jarvis)
    estado = {
        "last_run": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ok": len(stats["falhas"]) == 0,
        "detail": (f"{len(escolhidos)} noticias de {stats['vistos']} itens varridos"
                   + (f" - {len(stats['falhas'])} fonte(s) falharam" if stats["falhas"] else "")),
        "count": len(escolhidos),
    }
    with open(os.path.join(destino, "radar-noticias.json"), "w", encoding="utf-8") as f:
        json.dump(estado, f, ensure_ascii=False, indent=2)

    # 2) o boletim em si, pro Jarvis mostrar e narrar
    audio = ""
    for ext in (".m4a", ".wav"):
        if os.path.exists(os.path.join(pasta, "boletim" + ext)):
            audio = os.path.join(pasta, "boletim" + ext)
            break
    boletim = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "pasta": pasta,
        "html": os.path.join(pasta, "boletim.html"),
        "audio": audio,
        "manchetes": [{
            "titulo": it["titulo"], "veiculo": it["veiculo"],
            "link": it["link"], "score": it["score"],
        } for it in escolhidos],
    }
    with open(os.path.join(destino, "radar-boletim.json"), "w", encoding="utf-8") as f:
        json.dump(boletim, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
