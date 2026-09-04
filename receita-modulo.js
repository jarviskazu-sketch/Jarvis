/* MÓDULO "receita" — a geladeira na ordem certa, dentro do Jarvis.
 *
 * O código deste módulo NÃO mora aqui. Ele é construído no projeto Receita
 * (D:\8 - Claude - projeto\Receita) e exportado para `receita/` com
 * `npm run jarvis`. Este arquivo é só a ponte entre a antena e ele.
 *
 * O detalhe que faz isso valer a pena: o Worker construído para a Cloudflare
 * não tem import externo nem API exclusiva da plataforma, então roda em Node
 * sem alteração nenhuma. É o MESMO bundle nos dois lugares — o que sobe na
 * nuvem e o que roda aqui. Reescrever a lógica em JS de servidor daria duas
 * versões para manter, e elas divergiriam na primeira correção feita só de
 * um lado.
 *
 * O que esta ponte precisa fornecer, porque a Cloudflare fornecia:
 *   - env.DESPENSA : KV. Aqui é um JSON em agent-state/.
 *   - env.ASSETS   : os estáticos. Aqui não é usado (quem serve é a antena).
 *   - identidade   : ver `COOKIE_LOCAL` abaixo.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const RAIZ = path.join(__dirname, "receita");
const CLIENTE = path.join(RAIZ, "client");
const WORKER = path.join(RAIZ, "worker.mjs");

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/* Na nuvem a identidade do visitante vem de um cookie, para cada navegador
   ter a sua despensa. Aqui isso não funcionaria e não faria sentido:
   o cookie é `Secure`, e navegador descarta cookie Secure em http://127.0.0.1;
   além disso o painel roda dentro de um iframe do Jarvis, onde as regras de
   cookie de terceiros entram no caminho. E a máquina é de uma pessoa só.
   Então a ponte injeta uma identidade fixa e o worker segue igual. */
const COOKIE_LOCAL = "receita_id=jarvislocal00000000000000000000";

let workerCarregado = null;
let erroDoWorker = null;

async function carregarWorker() {
  if (workerCarregado) return workerCarregado;
  if (!fs.existsSync(WORKER)) {
    erroDoWorker =
      "módulo não instalado — rode `npm run jarvis` no projeto Receita";
    return null;
  }
  try {
    const mod = await import(pathToFileURL(WORKER).href);
    workerCarregado = mod.default;
    return workerCarregado;
  } catch (e) {
    erroDoWorker = e.message;
    return null;
  }
}

/* ----------------------------- despensa em arquivo -----------------------------
   Implementa só os dois métodos que o worker usa do KV. Não é um KV completo
   e não precisa ser: o que passa por aqui é uma lista de compras. */
function abrirDespensaLocal(arquivo) {
  function ler() {
    try {
      return JSON.parse(fs.readFileSync(arquivo, "utf8"));
    } catch {
      return {};
    }
  }
  return {
    async get(chave, tipo) {
      const tudo = ler();
      const v = tudo[chave];
      if (v === undefined) return null;
      return tipo === "json" ? v : JSON.stringify(v);
    },
    async put(chave, valor) {
      const tudo = ler();
      try {
        tudo[chave] = JSON.parse(valor);
      } catch {
        tudo[chave] = valor;
      }
      fs.writeFileSync(arquivo, JSON.stringify(tudo, null, 2), "utf8");
    },
  };
}

/* --------------------------- estáticos do módulo --------------------------- */

function servirEstatico(pedido, res, corsHeaders) {
  // "/receita" e "/receita/" caem no index; qualquer outro caminho vira
  // arquivo. Rota desconhecida também devolve o index, porque a aplicação é
  // uma SPA — o mesmo que `not_found_handling: single-page-application` faz
  // na Cloudflare.
  let relativo = pedido.replace(/^\/receita\/?/, "");
  if (!relativo || relativo.endsWith("/")) relativo = "index.html";

  // Trava de travessia: sem isto, "..%2F..%2Fserver.js" leria o que quisesse
  // da máquina. `resolve` normaliza o ".." ANTES da checagem.
  const alvo = path.resolve(CLIENTE, relativo);
  if (!alvo.startsWith(CLIENTE + path.sep) && alvo !== CLIENTE) {
    res.writeHead(403, corsHeaders());
    res.end("caminho fora do modulo");
    return;
  }

  let arquivo = alvo;
  if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
    arquivo = path.join(CLIENTE, "index.html");
  }
  if (!fs.existsSync(arquivo)) {
    res.writeHead(503, { ...corsHeaders(), "content-type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><meta charset="utf-8">' +
        '<body style="font:15px system-ui;background:#f3f0e7;color:#1d211b;padding:40px;max-width:520px;margin:auto">' +
        "<h2>Módulo não instalado</h2>" +
        "<p>Abra o projeto <code>Receita</code> e rode:</p>" +
        '<pre style="background:#e9e4d7;padding:12px;border-radius:8px">npm run jarvis</pre>' +
        "<p>Isso constrói o módulo e o instala aqui dentro.</p></body>"
    );
    return;
  }

  const tipo = TIPOS[path.extname(arquivo).toLowerCase()] || "application/octet-stream";
  // Os arquivos com hash no nome podem ser cacheados para sempre; o index não,
  // senão um `npm run jarvis` novo não apareceria sem limpar o navegador.
  const cache = /\/assets\/.*-[A-Za-z0-9_]{8,}\./.test(arquivo.replace(/\\/g, "/"))
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  res.writeHead(200, { ...corsHeaders(), "content-type": tipo, "cache-control": cache });
  fs.createReadStream(arquivo).pipe(res);
}

/* ------------------------------- ponte da API ------------------------------- */

async function servirApi(req, res, parsedReq, corsHeaders, opcoes) {
  const worker = await carregarWorker();
  if (!worker) {
    res.writeHead(503, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Módulo indisponível: " + erroDoWorker }));
    return;
  }

  // O worker fala Web Request/Response; o Node fala stream. Esta é a
  // tradução, e é toda a "cola" que o módulo precisa.
  const corpo = await new Promise((resolve) => {
    const partes = [];
    req.on("data", (p) => partes.push(p));
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });

  // /api/receita/menu  ->  /api/menu
  const caminho = parsedReq.pathname.replace(/^\/api\/receita/, "/api");
  const url = "http://127.0.0.1" + caminho + parsedReq.search;

  const cabecalhos = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && k !== "host" && k !== "cookie") cabecalhos.set(k, v);
  }
  cabecalhos.set("cookie", COOKIE_LOCAL);

  const pedido = new Request(url, {
    method: req.method,
    headers: cabecalhos,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : corpo,
  });

  let resposta;
  try {
    resposta = await worker.fetch(pedido, {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || opcoes.chaveAnthropic || "",
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "",
      DESPENSA: abrirDespensaLocal(opcoes.arquivoDespensa),
    });
  } catch (e) {
    console.log("[receita] erro no worker:", e.message);
    res.writeHead(500, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Algo deu errado. Tente novamente." }));
    return;
  }

  const saida = { ...corsHeaders() };
  resposta.headers.forEach((v, k) => {
    // O Set-Cookie do worker não serve aqui: a identidade é fixa e injetada
    // na entrada. Deixá-lo passar só criaria um cookie que ninguém lê.
    if (k.toLowerCase() !== "set-cookie") saida[k] = v;
  });

  res.writeHead(resposta.status, saida);
  res.end(Buffer.from(await resposta.arrayBuffer()));
}

/* ---------------------------------------------------------------------------
   Ponto único de entrada. Devolve true se tratou a requisição, para a antena
   poder chamar isto antes das rotas dela e seguir em frente se não for nossa. */
function tratar(req, res, parsedReq, corsHeaders, opcoes) {
  const p = parsedReq.pathname;

  if (p === "/receita" || p.startsWith("/receita/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, corsHeaders());
      res.end();
      return true;
    }
    servirEstatico(p, res, corsHeaders);
    return true;
  }

  if (p === "/api/receita" || p.startsWith("/api/receita/")) {
    servirApi(req, res, parsedReq, corsHeaders, opcoes).catch((e) => {
      console.log("[receita] falha inesperada:", e.message);
      try {
        res.writeHead(500, corsHeaders());
        res.end();
      } catch {
        /* resposta já iniciada */
      }
    });
    return true;
  }

  return false;
}

function instalado() {
  return fs.existsSync(WORKER) && fs.existsSync(path.join(CLIENTE, "index.html"));
}

module.exports = { tratar, instalado };
