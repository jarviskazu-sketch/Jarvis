/* Servidor de arquivos para os módulos embutidos do Jarvis (receita, personal).
 *
 * Existe compartilhado por um motivo específico: a trava contra travessia de
 * caminho é código de segurança. Duplicada em cada módulo, uma correção
 * futura teria de ser lembrada duas vezes — e a que fosse esquecida vira o
 * buraco. Aqui é um lugar só.
 */

const fs = require("fs");
const path = require("path");

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Serve um arquivo do diretório do módulo, com fallback de SPA.
 *
 * @param {object} opcoes
 * @param {string} opcoes.raiz      diretório do build (absoluto)
 * @param {string} opcoes.prefixo   ex: "/personal"
 * @param {string} opcoes.pedido    o pathname da requisição
 * @param {object} opcoes.res       resposta do Node
 * @param {Function} opcoes.corsHeaders
 * @param {string} opcoes.comoInstalar  comando a mostrar se o build faltar
 */
function servir({ raiz, prefixo, pedido, res, corsHeaders, comoInstalar }) {
  // "/personal" e "/personal/" caem no index; o resto vira caminho de arquivo.
  const semPrefixo = pedido.slice(prefixo.length).replace(/^\//, "");
  const relativo = !semPrefixo || semPrefixo.endsWith("/") ? "index.html" : semPrefixo;

  // `resolve` normaliza ".." ANTES da checagem — é isso que faz a trava
  // funcionar contra "../../server.js" e suas variações.
  const alvo = path.resolve(raiz, relativo);
  if (!alvo.startsWith(raiz + path.sep) && alvo !== raiz) {
    res.writeHead(403, corsHeaders());
    res.end("caminho fora do modulo");
    return;
  }

  let arquivo = alvo;
  if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
    // Rota desconhecida devolve o index: a aplicação é uma SPA e resolve o
    // roteamento no cliente.
    arquivo = path.join(raiz, "index.html");
  }

  if (!fs.existsSync(arquivo)) {
    res.writeHead(503, { ...corsHeaders(), "content-type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><meta charset="utf-8">' +
        '<body style="font:15px system-ui;background:#f4f6f1;color:#17231d;padding:40px;max-width:520px;margin:auto">' +
        "<h2>Módulo não instalado</h2><p>Rode no projeto de origem:</p>" +
        `<pre style="background:#dce3dc;padding:12px;border-radius:8px">${comoInstalar}</pre>` +
        "</body>"
    );
    return;
  }

  const tipo = TIPOS[path.extname(arquivo).toLowerCase()] || "application/octet-stream";
  // Arquivo com hash no nome pode ser cacheado para sempre; o index não,
  // senão uma reexportação não apareceria sem limpar o navegador.
  const temHash = /[-.][A-Za-z0-9_]{8,}\.(js|css)$/.test(arquivo);
  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": tipo,
    "cache-control": temHash ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(arquivo).pipe(res);
}

module.exports = { servir };
