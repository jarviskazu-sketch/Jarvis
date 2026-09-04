/* MÓDULO "form" — coach visual de execução de exercícios, dentro do Jarvis.
 *
 * O código deste módulo NÃO mora aqui. É construído no projeto Form
 * (D:\8 - Claude - projeto\Form) e exportado para `form/` com
 * `npm run jarvis`. Este arquivo é só a ponte com a antena.
 *
 * Ao contrário do receita, aqui NÃO existe parte de servidor: nem Worker,
 * nem API, nem armazenamento. É de propósito, e é a promessa do produto —
 * o vídeo é lido quadro a quadro pelo MediaPipe dentro do navegador, a
 * rotina é gerada por regras determinísticas no cliente, e o único dado
 * guardado é o plano da semana, no localStorage do próprio aparelho.
 *
 * Ou seja: a antena serve arquivos e mais nada. Se um dia aparecer uma rota
 * /api/form aqui, é sinal de que alguém quebrou a promessa de privacidade.
 */

const fs = require("fs");
const path = require("path");
const { servir } = require("./modulo-estatico");

const RAIZ = path.join(__dirname, "form");
const PREFIXO = "/form";

function tratar(req, res, parsedReq, corsHeaders) {
  const p = parsedReq.pathname;
  if (p !== PREFIXO && !p.startsWith(PREFIXO + "/")) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, corsHeaders());
    res.end();
    return true;
  }

  servir({
    raiz: RAIZ,
    prefixo: PREFIXO,
    pedido: p,
    res,
    corsHeaders,
    comoInstalar: "npm run jarvis",
  });
  return true;
}

function instalado() {
  return fs.existsSync(path.join(RAIZ, "index.html"));
}

module.exports = { tratar, instalado };
