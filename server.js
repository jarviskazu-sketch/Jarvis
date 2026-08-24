/*
 * ANTENA DO JARVIS
 * Node puro (http, https, tls) — zero dependências, zero npm install.
 * Escuta só em 127.0.0.1: existe unicamente para o jarvis.html do
 * seu próprio navegador ler agenda, e-mails e notícias sem esbarrar
 * no CORS. Rode com: node server.js
 */

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 4242;

/* ============ SEGUNDO CÉREBRO ============
   Memória persistente em D:\SEGUNDO-CEREBRO, alimentada pelos hooks do Claude Code.
   O Jarvis não lê os arquivos do cofre direto: conversa com o CLI dele, que já
   sabe pontuar relevância, respeitar o que é sensível e manter o índice. Assim
   a regra de busca mora num lugar só. */
const CEREBRO_BIN = path.join("D:", "SEGUNDO-CEREBRO", "_SISTEMA", "bin", "cerebro.mjs");
const CEREBRO_AGENT_EVERY_MIN = 30;

/* Chama o CLI do cérebro e devolve o JSON. Timeout curto: se o cérebro estiver
   indisponível, o Jarvis segue funcionando sem ele — nunca trava por causa disso. */
function chamarCerebro(args, cb) {
  execFile("node", [CEREBRO_BIN, ...args], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return cb(err);
    try {
      cb(null, JSON.parse(String(stdout).replace(/^\uFEFF/, "")));
    } catch (e) {
      cb(new Error("resposta do cerebro nao e JSON: " + e.message));
    }
  });
}

/* Manda algo para o cérebro registrar. Usa spawn porque o comando `anotar`
   lê JSON do stdin — e assim o tamanho não esbarra no limite de linha de comando. */
function registrarNoCerebro(entrada, fonte, cb) {
  const { spawn } = require("child_process");
  const p = spawn("node", [CEREBRO_BIN, "anotar", fonte], { windowsHide: true });
  let saida = "";
  p.stdout.on("data", (d) => (saida += d));
  p.on("error", (e) => cb && cb(e));
  p.on("close", () => cb && cb(null, saida.trim()));
  p.stdin.end(JSON.stringify(entrada), "utf8");
}

/* Palavras vazias em pt-BR para achar o assunto do dia nas manchetes. */
const STOP_MANCHETE = new Set(["para","com","que","uma","dos","das","por","como","mais","mas","não","nao","sobre","após","apos","entre","pelo","pela","seu","sua","ser","tem","vai","ainda","novo","nova","diz","veja","saiba","the","and","for"]);

/* Extrai o assunto dominante de uma lista de manchetes. Não guarda as manchetes:
   o que interessa ao cérebro é o TEMA que se repete, não a notícia do dia. */
function assuntosDominantes(titulos, quantos) {
  const freq = new Map();
  for (const t of titulos) {
    const palavras = String(t).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
    for (const w of palavras) {
      if (w.length < 4 || STOP_MANCHETE.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, quantos);
}

/* ============ AGENTES AUTÔNOMOS ============
   Processos que rodam sozinhos, sem pedido do navegador — diferente das
   rotas acima (proxy/emails), que só existem quando alguém pede.
   Cada agente grava prova de vida em agent-state/<id>.json a cada rodada. */
const AGENT_STATE_DIR = path.join(__dirname, "agent-state");
const AGENTS_CONFIG_PATH = path.join(__dirname, "agents-config.json");

/* fator sobre a cadência que marca um agente como "atrasado" (stale) —
   ex: agente de 15min stale depois de 15*2.5 = 37.5min sem rodar. Ajuste aqui. */
const STALE_FACTOR = 2.5;
const NEWS_AGENT_EVERY_MIN = 15;
const AGENDA_AGENT_EVERY_MIN = 10;

/* Domínios liberados para o proxy de agenda/notícias.
   Se sua agenda usar outro domínio (ex: outro provedor de calendário),
   adicione aqui — é seu arquivo, roda local, editar é seguro. */
const ALLOWED_PROXY_HOSTS = [
  "calendar.google.com",
  "news.google.com",
  "outlook.office365.com",
  "outlook.live.com",
  "outlook.office.com",
  "titan.email"
];

/* Hosts IMAP liberados para a Central de E-mails.
   Adicione aqui outros provedores se precisar. */
const ALLOWED_IMAP_HOSTS = [
  "imap.gmail.com",
  "titan.email",
  "outlook.office365.com"
];

function isAllowedHost(hostname, list) {
  const h = String(hostname || "").toLowerCase();
  return list.some((allowed) => h === allowed || h.endsWith("." + allowed));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    // Chrome recente exige isso pra deixar uma página file:// (ou qualquer origem
    // "pública") acessar 127.0.0.1 — sem esse header o navegador bloqueia com
    // status "blocked:origin" antes mesmo da requisição chegar aqui.
    "Access-Control-Allow-Private-Network": "true"
  };
}

function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 0) return "***";
  return s.slice(0, 2) + "***" + s.slice(at);
}
function maskSecret() {
  return "••••••••";
}

function loginFailedMessage(host) {
  const h = String(host || "").toLowerCase();
  if (h.endsWith("imap.gmail.com")) {
    return "Senha de app invalida ou verificacao em 2 etapas desativada - refaca em myaccount.google.com/apppasswords";
  }
  if (h.endsWith("outlook.office365.com")) {
    return "Login recusado pelo Outlook/365. Se for conta pessoal, gere a senha de app em account.live.com/proofs/AppPassword. Se for conta corporativa (like a da empresa), o IMAP com senha de app pode estar bloqueado pelo administrador de TI (a Microsoft desativou por padrao o login basico do IMAP em contas corporativas desde 2022) - confirme com o TI se a autenticacao basica/IMAP esta liberada pra essa caixa.";
  }
  if (h.endsWith("titan.email")) {
    return "Login recusado pelo Titan/HostGator. Confirme usuario (e-mail completo) e senha, e confirme que o IMAP esta habilitado na caixa (Configuracoes > POP/IMAP no webmail).";
  }
  return "Senha de app invalida ou login recusado pelo provedor.";
}

/* ============ BUSCA HTTPS COM REDIRECTS (proxy de agenda/notícias) ============ */
function fetchWithRedirects(targetUrl, maxRedirects, cb) {
  let redirectsLeft = maxRedirects;
  function go(u) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch (e) {
      cb(new Error("URL inválida"));
      return;
    }
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || 443,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      }
    };
    const req = https.get(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        redirectsLeft--;
        const nextUrl = new URL(res.headers.location, u).toString();
        res.resume();
        go(nextUrl);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, { statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", (err) => cb(err));
    req.setTimeout(15000, () => req.destroy(new Error("tempo esgotado")));
  }
  go(targetUrl);
}

/* ============ AGENTES — funções auxiliares ============ */
function ensureAgentDir() {
  try { if (!fs.existsSync(AGENT_STATE_DIR)) fs.mkdirSync(AGENT_STATE_DIR, { recursive: true }); } catch (e) {}
}

function loadAgentsConfig() {
  try {
    if (!fs.existsSync(AGENTS_CONFIG_PATH)) {
      const def = { newsTopics: ["tecnologia", "economia", "mercado de energia"], calendars: [] };
      fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(def, null, 2));
      return def;
    }
    return JSON.parse(fs.readFileSync(AGENTS_CONFIG_PATH, "utf8"));
  } catch (e) {
    console.log("[agentes] erro ao ler agents-config.json:", e.message);
    return { newsTopics: [], calendars: [], _configError: e.message };
  }
}

function writeAgentState(id, state) {
  ensureAgentDir();
  try {
    fs.writeFileSync(path.join(AGENT_STATE_DIR, id + ".json"), JSON.stringify(state, null, 2));
  } catch (e) {
    console.log(`[agentes] erro ao gravar estado de ${id}:`, e.message);
  }
}

/* distingue "nunca rodou" (arquivo não existe = legítimo) de "erro de leitura"
   (arquivo existe mas está corrompido/sem permissão = erro de verdade) */
function readAgentState(id) {
  const file = path.join(AGENT_STATE_DIR, id + ".json");
  try {
    return { data: lerJSON(file), error: null };
  } catch (e) {
    if (e.code === "ENOENT") return { data: null, error: null };
    return { data: null, error: e.message };
  }
}

function fetchTextPromise(url) {
  return new Promise((resolve, reject) => {
    fetchWithRedirects(url, 3, (err, result) => {
      if (err) return reject(err);
      if (result.statusCode >= 400) return reject(new Error("http " + result.statusCode));
      resolve(result.body.toString("utf8"));
    });
  });
}

async function runNewsAgent() {
  const cfg = loadAgentsConfig();
  if (cfg._configError) {
    writeAgentState("news-radar", { last_run: new Date().toISOString(), ok: false, detail: "config ilegivel: " + cfg._configError, count: 0 });
    return;
  }
  const topics = cfg.newsTopics || [];
  if (!topics.length) return; // sem tema configurado — agente fica "off", sem gravar estado

  let totalItems = 0;
  const failures = [];
  const porTema = {};
  const titulos = [];

  for (const topic of topics) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
      const xml = await fetchTextPromise(url);
      const itens = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      totalItems += itens.length;
      porTema[topic] = itens.length;
      for (const it of itens) {
        const m = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(it);
        if (m) titulos.push(m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
      }
    } catch (e) {
      failures.push(topic + ": " + e.message);
    }
  }

  const anterior = readAgentState("news-radar").data || {};
  const hoje = new Date().toISOString().slice(0, 10);

  /* Uma vez por dia, o radar deixa registro no DIÁRIO do cérebro — nunca em notas.
     A regra do cofre é "uma nota = um fato durável"; manchete não sobrevive a três
     meses e viraria ruído no recall. O que fica é o assunto dominante do dia. */
  if (anterior.ultimo_digest !== hoje && titulos.length) {
    const assuntos = assuntosDominantes(titulos, 8).map(([p, n]) => `${p} (${n})`).join(", ");
    const porTemaTxt = Object.entries(porTema).map(([t, n]) => `${t}: ${n}`).join(" · ");
    registrarNoCerebro({
      notas: [],
      projeto: "Jarvis",
      diario: `Radar de notícias — ${totalItems} manchetes em ${topics.length} temas (${porTemaTxt}).\nAssuntos dominantes: ${assuntos}.`
    }, "jarvis-radar", (err) => {
      if (err) console.log("[agentes] news-radar nao conseguiu registrar no cerebro:", err.message);
    });
  }

  const ok = failures.length < topics.length;
  writeAgentState("news-radar", {
    last_run: new Date().toISOString(),
    ok,
    detail: failures.length
      ? `${totalItems} manchetes em ${topics.length - failures.length}/${topics.length} temas (falha: ${failures.join("; ")})`
      : `${totalItems} manchetes em ${topics.length} tema(s)`,
    count: totalItems,
    ultimo_digest: titulos.length ? hoje : anterior.ultimo_digest
  });
}

/* ============ LEITURA DE ICS ============
   Parser mínimo: desdobra linhas continuadas (o formato quebra em 75 colunas e
   continua com espaço no início) e extrai só DTSTART e SUMMARY de cada VEVENT. */
function desdobrarICS(texto) {
  return String(texto).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function parseDataICS(valor) {
  // formatos: 20260812T143000Z · 20260812T143000 · 20260812 (dia inteiro)
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(valor).trim());
  if (!m) return null;
  const [, a, mes, d, h, min, s, z] = m;
  const diaInteiro = !h;
  const iso = `${a}-${mes}-${d}` + (diaInteiro ? "T00:00:00" : `T${h}:${min}:${s}`) + (z ? "Z" : "");
  const data = new Date(iso);
  return isNaN(data) ? null : { data, diaInteiro };
}

function extrairEventos(ics, nomeAgenda) {
  const texto = desdobrarICS(ics);
  const eventos = [];
  const blocos = texto.split("BEGIN:VEVENT").slice(1);
  for (const bloco of blocos) {
    const corpo = bloco.split("END:VEVENT")[0];
    const mDt = /^DTSTART[^:\n]*:(.+)$/m.exec(corpo);
    const mSum = /^SUMMARY[^:\n]*:(.+)$/m.exec(corpo);
    if (!mDt) continue;
    const quando = parseDataICS(mDt[1]);
    if (!quando) continue;
    const titulo = (mSum ? mSum[1] : "(sem título)")
      .replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
    eventos.push({ agenda: nomeAgenda, titulo, inicio: quando.data.toISOString(), diaInteiro: quando.diaInteiro });
  }
  return eventos;
}

/* Rótulo seguro de uma agenda. NUNCA cair na URL: os feeds ICS são secretos —
   quem tem o link lê a agenda inteira — e este texto vai para o estado em disco
   e para a tela. Sem nome configurado, mostra só o host. */
function rotuloAgenda(cal) {
  if (cal.nome) return cal.nome;
  if (cal.name) return cal.name;
  try { return new URL(cal.url).hostname; } catch (e) { return "agenda sem nome"; }
}

const AGENDA_JANELA_DIAS = 14;

async function runAgendaAgent() {
  const cfg = loadAgentsConfig();
  if (cfg._configError) {
    writeAgentState("agenda-sync", { last_run: new Date().toISOString(), ok: false, detail: "config ilegivel: " + cfg._configError, count: 0 });
    return;
  }
  const calendars = cfg.calendars || [];
  if (!calendars.length) return; // sem agenda configurada — agente fica "off", sem gravar estado

  let totalEvents = 0;
  const failures = [];
  const proximos = [];
  const agora = Date.now();
  const limite = agora + AGENDA_JANELA_DIAS * 24 * 60 * 60 * 1000;

  for (const cal of calendars) {
    const rotulo = rotuloAgenda(cal);
    try {
      const ics = await fetchTextPromise(cal.url);
      totalEvents += (ics.match(/BEGIN:VEVENT/g) || []).length;
      for (const ev of extrairEventos(ics, rotulo)) {
        const t = Date.parse(ev.inicio);
        if (t >= agora && t <= limite) proximos.push(ev);
      }
    } catch (e) {
      failures.push(rotulo + ": " + e.message);
    }
  }

  proximos.sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio));

  /* Compromissos da janela, para o segundo cérebro ler no início de cada sessão.
     Fica AQUI, no Jarvis, e o cérebro só lê — não copia. Assim título de reunião
     não vira nota nem entra no export do cofre. */
  writeAgentState("agenda-proximos", {
    gerado_em: new Date().toISOString(),
    janela_dias: AGENDA_JANELA_DIAS,
    total: proximos.length,
    eventos: proximos.slice(0, 60)
  });

  const ok = failures.length < calendars.length;
  writeAgentState("agenda-sync", {
    last_run: new Date().toISOString(),
    ok,
    detail: failures.length
      ? `${totalEvents} eventos, ${calendars.length - failures.length}/${calendars.length} agenda(s) ok (falha: ${failures.join("; ")})`
      : `${totalEvents} eventos em ${calendars.length} agenda(s) · ${proximos.length} nos próximos ${AGENDA_JANELA_DIAS} dias`,
    count: totalEvents
  });
}

/* Vigia a saúde do segundo cérebro: quantas notas existem, se sobrou sessão por
   destilar e se a credencial do CLI ainda vale. É o agente que avisa quando a
   memória parou de ser escrita — falha que, sem isso, passaria despercebida. */
async function runCerebroAgent() {
  const dados = await new Promise((resolve, reject) => {
    chamarCerebro(["resumo"], (err, json) => (err ? reject(err) : resolve(json)));
  });

  /* Semântica de monitor, não de tarefa: a consulta pode ter dado certo e ainda
     assim o cérebro estar doente (credencial vencida, sessão empilhada na fila).
     Nesse caso reportamos ok:false de propósito, para o painel acender — igual a
     uma sonda que responde "alvo fora do ar" mesmo tendo executado sem falha.
     Se o CLI do cérebro nem responder, o erro sobe pelo catch de quem chamou. */
  writeAgentState("cerebro-sync", {
    last_run: new Date().toISOString(),
    ok: dados.ok === true,
    detail: dados.detalhe,
    count: dados.notas,
    fila: dados.fila,
    auth: dados.auth,
    porArea: dados.porArea
  });
}

const AGENT_DEFS = [
  {
    id: "cerebro-sync",
    nome: "Segundo Cérebro",
    icon: "🧠",
    faz: "Vigia a memória em D:\\SEGUNDO-CEREBRO — total de notas, sessões esperando destilação e validade da credencial.",
    every_min: CEREBRO_AGENT_EVERY_MIN,
    arquivo: "agent-state/cerebro-sync.json",
    isOff: () => !fs.existsSync(CEREBRO_BIN),
    offDetail: "cérebro não encontrado em D:\\SEGUNDO-CEREBRO",
    run: runCerebroAgent
  },
  {
    id: "news-radar",
    nome: "Radar de Notícias",
    icon: "📰",
    faz: "Busca manchetes do Google News pros assuntos configurados, sozinho, sem precisar do navegador aberto.",
    every_min: NEWS_AGENT_EVERY_MIN,
    arquivo: "agent-state/news-radar.json",
    isOff: (cfg) => !(cfg.newsTopics && cfg.newsTopics.length),
    offDetail: "desligado — adicione temas em newsTopics no agents-config.json",
    run: runNewsAgent
  },
  {
    id: "agenda-sync",
    nome: "Sync de Agenda",
    icon: "📅",
    faz: "Baixa e conta os eventos das agendas ICS configuradas, sozinho, sem precisar do navegador aberto.",
    every_min: AGENDA_AGENT_EVERY_MIN,
    arquivo: "agent-state/agenda-sync.json",
    isOff: (cfg) => !(cfg.calendars && cfg.calendars.length),
    offDetail: "desligado — adicione agendas em calendars no agents-config.json",
    run: runAgendaAgent
  },
  {
    // Este roda FORA do Jarvis: é o sistema em ~/RadarDeNoticias, agendado no
    // Windows pras 07:00. Ele mesmo grava a prova de vida em agent-state/,
    // por isso aqui não há função run — quem dispara é o Agendador de Tarefas.
    id: "radar-noticias",
    nome: "Radar (boletim diário)",
    icon: "🗞",
    faz: "Monta o boletim do dia de energia e seguros, com áudio narrado, todo dia às 07h — mesmo com o Jarvis fechado.",
    every_min: 24 * 60,
    arquivo: "agent-state/radar-noticias.json",
    isOff: () => !fs.existsSync(path.join(AGENT_STATE_DIR, "radar-noticias.json")),
    offDetail: "ainda não rodou — agende com: radar agendar",
    run: null
  }
];

/* Lê JSON tolerando BOM. O PowerShell grava UTF-8 COM BOM por padrão, e o
   JSON.parse do Node quebra no caractere invisível do começo do arquivo. */
function lerJSON(caminho) {
  let txt = fs.readFileSync(caminho, "utf8");
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt);
}

function computeAgentSnapshot(def, cfg) {
  const base = { id: def.id, nome: def.nome, icon: def.icon, faz: def.faz, every_min: def.every_min, arquivo: def.arquivo };
  // Só expõe "rodar agora" se o agente REALMENTE tiver como ser disparado daqui.
  // Sem esse check, um agente externo (que quem dispara é o Agendador do Windows)
  // ganharia um botão que diz "concluído" sem ter executado nada.
  const runRef = def.run ? { url: `/api/agents/${def.id}/run`, method: "POST" } : null;

  if (def.isOff(cfg)) {
    return { ...base, last: null, age_min: null, next_in_min: null, phase: null, state: "off", metric: "desligado", detail: def.offDetail, run: null };
  }

  const { data, error } = readAgentState(def.id);

  if (error) {
    return { ...base, last: null, age_min: null, next_in_min: null, phase: null, state: "error", metric: "—", detail: "erro ao ler estado: " + error, run: runRef };
  }
  if (!data) {
    return { ...base, last: null, age_min: null, next_in_min: null, phase: null, state: "idle", metric: "nunca rodou", detail: "aguardando a primeira rodada", run: runRef };
  }

  const ageMin = (Date.now() - new Date(data.last_run).getTime()) / 60000;
  const phase = Math.min(1, ageMin / def.every_min);
  const nextIn = Math.max(0, def.every_min - ageMin);
  let state;
  if (!data.ok) state = "error";
  else if (ageMin > def.every_min * STALE_FACTOR) state = "stale";
  else state = "ok";

  return {
    ...base,
    last: data.last_run,
    age_min: +ageMin.toFixed(1),
    next_in_min: +nextIn.toFixed(1),
    phase: +phase.toFixed(3),
    state,
    metric: data.detail || "—",
    detail: data.detail || "",
    run: runRef
  };
}

/* ============================ O VIGIA ============================
   Camada 1 do Jarvis-cérebro: a única pergunta que ele faz é
   "quem devia ter falado hoje e não falou?".

   Por que isso existe: o Radar parou de gerar boletim em 17/08 e ficou
   7 dias assim sem ninguém notar — porque ninguém procura o que não
   chega. E o cérebro exibiu "autenticação expirada" no painel por 67
   dias — porque MOSTRAR não é AVISAR.

   Duas escolhas de projeto que vêm daí:

   1) Ele guarda DESDE QUANDO o agente está ruim. O estado sozinho diz
      "parado"; o que muda o seu comportamento é "parado há 7 dias".
      Sem memória do início, todo dia parece o primeiro.

   2) Ele não decide nada nem chama IA. É contagem de tempo, e só. A
      camada que interpreta vem depois e vai ler ISTO — nunca os 300
      eventos crus. */

const VIGIA_EVERY_MIN = 5;
const VIGIA_ARQ = path.join(AGENT_STATE_DIR, "vigia.json");

function plural(n, um, muitos) { return n === 1 ? `1 ${um}` : `${n} ${muitos}`; }

function haQuantoTempo(desdeISO) {
  const min = (Date.now() - new Date(desdeISO).getTime()) / 60000;
  if (min < 90) return `há ${plural(Math.max(1, Math.round(min)), "minuto", "minutos")}`;
  const h = min / 60;
  if (h < 36) return `há ${plural(Math.round(h), "hora", "horas")}`;
  return `há ${plural(Math.round(h / 24), "dia", "dias")}`;
}

function avaliarVigia(cfg) {
  let anterior = {};
  try { anterior = lerJSON(VIGIA_ARQ).problemas_por_id || {}; } catch { /* primeira vez */ }

  const agora = new Date().toISOString();
  const problemas = {};
  const alertas = [];

  for (const def of AGENT_DEFS) {
    let snap;
    try { snap = computeAgentSnapshot(def, cfg); }
    catch (e) { continue; }

    // "off" é escolha do dono (agente desligado de propósito), não é falha
    if (snap.state === "off" || snap.state === "ok") continue;

    let motivo;
    if (snap.state === "stale")      motivo = "mudo";
    else if (snap.state === "error") motivo = "falhando";
    else if (snap.state === "idle")  motivo = "nunca rodou";
    else continue;

    // Desde quando está ruim.
    //
    // Para "mudo" dá pra saber de verdade, olhando a última vez que o agente
    // falou — e isso é retroativo: um Radar parado há 7 dias é reportado como
    // 7 dias já na PRIMEIRA rodada do vigia, sem precisar tê-lo observado o
    // tempo todo. Sem isso, reiniciar a antena zeraria a idade de todo
    // problema e a mensagem viraria sempre "há 1 minuto".
    //
    // Para "falhando" não dá: o arquivo de estado só guarda a situação atual,
    // não desde quando ela dura. Aí o relógio é o do próprio vigia, e a
    // primeira medição subestima. É uma limitação honesta, não um bug.
    const antes = anterior[def.id];
    let desde;
    if (motivo === "mudo" && snap.last) desde = new Date(snap.last).toISOString();
    else if (antes && antes.motivo === motivo) desde = antes.desde;
    else desde = agora;

    problemas[def.id] = { nome: def.nome, motivo, desde, detalhe: snap.detail || "" };

    const quanto = haQuantoTempo(desde);
    if (motivo === "mudo") {
      const esperado = def.every_min >= 1440
        ? `devia rodar todo dia`
        : `devia rodar a cada ${def.every_min} min`;
      alertas.push(`${def.nome}: sem dar sinal ${quanto} — ${esperado}.`);
    } else if (motivo === "falhando") {
      // Só o PROBLEMA, não o status inteiro. O detalhe do cérebro é
      // "54 notas · 15 áreas · 917 arquivos · ⚠ login expirado · 5 na fila":
      // colado inteiro no alerta, vira ruído — e o boletim LÊ isso em voz
      // alta, então "novecentos e dezessete arquivos catalogados" entra no
      // meio de um aviso. Depois do "⚠" está o que interessa.
      let porque = snap.detail || "";
      const i = porque.indexOf("⚠");
      if (i >= 0) porque = porque.slice(i + 1).trim();
      if (porque.length > 90) porque = porque.slice(0, 90).trim() + "...";
      alertas.push(`${def.nome}: falhando ${quanto}${porque ? " — " + porque : ""}.`);
    } else {
      alertas.push(`${def.nome}: nunca rodou.`);
    }
  }

  const saida = {
    last_run: agora,
    ok: alertas.length === 0,
    detail: alertas.length ? `${plural(alertas.length, "agente com problema", "agentes com problema")}` : "todos os agentes respondendo",
    count: alertas.length,
    alertas,
    problemas_por_id: problemas
  };

  try {
    fs.writeFileSync(VIGIA_ARQ, JSON.stringify(saida, null, 2), "utf8");
  } catch (e) {
    console.log("[vigia] nao consegui gravar vigia.json:", e.message);
  }
  return saida;
}

function rodarVigia() {
  let cfg = {};
  try { cfg = lerJSON(path.join(__dirname, "agents-config.json")); } catch { /* sem config */ }
  const r = avaliarVigia(cfg);
  if (r.alertas.length) console.log("[vigia] " + r.alertas.join(" | "));
  return r;
}

/* ============ CLIENTE IMAP MÍNIMO (só tls nativo) ============ */
class ImapClient {
  constructor(host) {
    this.host = host;
    this.tagN = 0;
    this.acc = "";
    this.socket = null;
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = tls.connect({ host: this.host, port: 993, servername: this.host }, () => {});
      this.socket.setTimeout(20000, () => {
        if (!settled) { settled = true; reject(new Error("timeout ao conectar no IMAP")); }
        this.socket.destroy();
      });
      this.socket.on("data", (chunk) => {
        this.acc += chunk.toString("latin1");
        this._checkWaiters();
      });
      this.socket.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
        this._rejectAll(err);
      });
      this._wait(null)
        .then(() => { settled = true; resolve(); })
        .catch((err) => { if (!settled) { settled = true; reject(err); } });
    });
  }
  _nextTag() {
    this.tagN++;
    return "A" + this.tagN;
  }
  _wait(tag) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ tag, resolve, reject });
      this._checkWaiters();
    });
  }
  _rejectAll(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }
  _checkWaiters() {
    if (!this.waiters.length) return;
    const w = this.waiters[0];
    if (w.tag === null) {
      const idx = this.acc.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.acc.slice(0, idx);
        this.acc = this.acc.slice(idx + 2);
        this.waiters.shift();
        w.resolve(line);
        this._checkWaiters();
      }
      return;
    }
    const marker = "\r\n" + w.tag + " ";
    let idx = this.acc.indexOf(marker);
    let markerLen = marker.length;
    if (idx === -1 && this.acc.startsWith(w.tag + " ")) {
      idx = -2; // marca "achou no início do buffer"
      markerLen = (w.tag + " ").length;
    }
    if (idx === -1) return;
    const searchFrom = idx === -2 ? 0 : idx + 2;
    const lineEnd = this.acc.indexOf("\r\n", searchFrom + markerLen);
    if (lineEnd === -1) return;
    const full = this.acc.slice(0, lineEnd + 2);
    this.acc = this.acc.slice(lineEnd + 2);
    this.waiters.shift();
    w.resolve(full);
    this._checkWaiters();
  }
  cmd(command) {
    const tag = this._nextTag();
    this.socket.write(tag + " " + command + "\r\n");
    return this._wait(tag).then((resp) => ({ tag, resp }));
  }
  quit() {
    try { this.socket.write("AZ LOGOUT\r\n"); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    try { this.socket.destroy(); } catch (e) {}
  }
}

function imapQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/* extrai os blocos "* N FETCH (...)" respeitando literais {N} */
function parseFetchBlocks(text) {
  const emails = [];
  const blockRe = /\*\s*(\d+)\s*FETCH\s*\(/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const p = blockRe.lastIndex;
    const uidM = /UID\s+(\d+)/.exec(text.slice(p, p + 40));
    const uid = uidM ? uidM[1] : String(m[1]);
    const flagsM = /FLAGS\s*\(([^)]*)\)/.exec(text.slice(p, p + 300));
    const flags = flagsM ? flagsM[1].split(/\s+/).filter(Boolean) : [];

    let cursor = p;
    let headerText = "";
    const headerMarkerRe = /BODY\[HEADER\.FIELDS[^\]]*\]\s*\{(\d+)\}\r\n/;
    const hM = headerMarkerRe.exec(text.slice(cursor, cursor + 2000));
    if (hM) {
      const literalLen = parseInt(hM[1], 10);
      const literalStart = cursor + hM.index + hM[0].length;
      headerText = text.slice(literalStart, literalStart + literalLen);
      cursor = literalStart + literalLen;
    }

    let bodyText = "";
    const bodyMarkerRe = /BODY\[TEXT\](?:<\d+>)?\s*\{(\d+)\}\r\n/;
    const bM = bodyMarkerRe.exec(text.slice(cursor, cursor + 200));
    if (bM) {
      const literalLen = parseInt(bM[1], 10);
      const literalStart = cursor + bM.index + bM[0].length;
      bodyText = text.slice(literalStart, literalStart + literalLen);
      cursor = literalStart + literalLen;
    }
    blockRe.lastIndex = cursor;
    emails.push({ uid, flags, headerRaw: headerText, bodyRaw: bodyText });
  }
  return emails;
}

function unfoldHeaders(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .reduce((acc, line) => {
      if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += " " + line.trim();
      else if (line.trim()) acc.push(line);
      return acc;
    }, []);
}
function getHeader(lines, name) {
  const re = new RegExp("^" + name + ":\\s*(.*)$", "i");
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1].trim();
  }
  return "";
}
function decodeMimeWords(s) {
  if (!s) return s;
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, data) => {
    try {
      let buf;
      if (enc.toUpperCase() === "B") {
        buf = Buffer.from(data, "base64");
      } else {
        const cleaned = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        buf = Buffer.from(cleaned, "latin1");
      }
      return buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
    } catch (e) {
      return data;
    }
  });
}
function decodeBodyContent(content, cte) {
  try {
    if (cte === "base64") return Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
    if (cte === "quoted-printable") {
      const unfolded = content.replace(/=\r\n/g, "");
      const bytes = unfolded.replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, "latin1").toString("utf8");
    }
    return Buffer.from(content, "latin1").toString("utf8");
  } catch (e) {
    return content;
  }
}
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function extractPlainText(bodyRaw, topContentType, topCTE) {
  const boundaryMatch = /boundary="?([^";\r\n]+)"?/i.exec(topContentType || "");
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = bodyRaw.split("--" + boundary);
    let plainPart = null, htmlPart = null;
    parts.forEach((part) => {
      const ctM = /Content-Type:\s*([^\r\n;]+)/i.exec(part);
      const cteM = /Content-Transfer-Encoding:\s*([^\r\n]+)/i.exec(part);
      const ct = ctM ? ctM[1].trim().toLowerCase() : "";
      const cte = cteM ? cteM[1].trim().toLowerCase() : "7bit";
      const blankIdx = part.indexOf("\r\n\r\n");
      if (blankIdx === -1) return;
      const content = part.slice(blankIdx + 4);
      const decoded = decodeBodyContent(content, cte);
      if (ct === "text/plain" && !plainPart) plainPart = decoded;
      else if (ct === "text/html" && !htmlPart) htmlPart = decoded;
    });
    if (plainPart) return plainPart;
    if (htmlPart) return stripHtml(htmlPart);
    return "";
  }
  const decoded = decodeBodyContent(bodyRaw, (topCTE || "7bit").toLowerCase());
  return /html/i.test(topContentType || "") ? stripHtml(decoded) : decoded;
}

async function fetchEmailsIMAP(host, usuario, senhaApp, quantidade) {
  // Defesa em profundidade: mesmo que o cliente esqueça, tira espaço da senha
  // de app (o Google exibe em blocos de 4) e do usuário.
  usuario = String(usuario || "").trim();
  senhaApp = String(senhaApp || "").replace(/\s+/g, "");
  const client = new ImapClient(host);
  await client.connect();
  const loginResp = await client.cmd("LOGIN " + imapQuote(usuario) + " " + imapQuote(senhaApp));
  if (!/\sOK\b/i.test(loginResp.resp)) {
    // a resposta do servidor nunca inclui a senha de volta - seguro de logar
    console.log(`[antena] resposta do LOGIN recusado (${host}): ${loginResp.resp.trim()}`);
    client.quit();
    throw new Error("LOGIN_FAILED");
  }
  const examineResp = await client.cmd("EXAMINE INBOX");
  const existsM = /\*\s*(\d+)\s*EXISTS/i.exec(examineResp.resp);
  const exists = existsM ? parseInt(existsM[1], 10) : 0;
  if (exists === 0) {
    // diagnóstico: mostra a resposta crua do EXAMINE quando não acha nenhuma mensagem,
    // pra distinguir "caixa realmente vazia" de "nosso regex não bateu com a resposta"
    console.log(`[antena] EXAMINE INBOX (${host}) voltou 0 mensagens. Resposta crua: ${JSON.stringify(examineResp.resp.slice(0, 500))}`);
    client.quit();
    return [];
  }
  const n = Math.max(1, Math.min(quantidade || 20, 200));
  const from = Math.max(1, exists - n + 1);
  const to = exists;
  // O verbo FETCH é obrigatório aqui: cmd() só prefixa a tag, então sem ele
  // o servidor recebe "A3 1:20 (...)", responde BAD e nenhuma mensagem volta —
  // dava login OK, caixa com mensagens, e mesmo assim zero e-mail na tela.
  const fetchResp = await client.cmd(
    `FETCH ${from}:${to} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.4000>)`
  );
  if (!/\sOK\b/i.test(fetchResp.resp)) {
    console.log(`[antena] FETCH recusado (${host}): ${fetchResp.resp.slice(0, 200)}`);
  }
  client.quit();
  const blocks = parseFetchBlocks(fetchResp.resp);
  console.log(`[antena] ${host}: caixa com ${exists} mensagem(ns), ${blocks.length} lida(s) nesta rodada`);
  return blocks.map((b) => {
    const hLines = unfoldHeaders(b.headerRaw);
    const from_ = decodeMimeWords(getHeader(hLines, "From"));
    const subject = decodeMimeWords(getHeader(hLines, "Subject"));
    const date = getHeader(hLines, "Date");
    const msgId = getHeader(hLines, "Message-Id") || host + "-" + b.uid;
    const ct = getHeader(hLines, "Content-Type");
    const cte = getHeader(hLines, "Content-Transfer-Encoding");
    let excerpt = "";
    try {
      excerpt = extractPlainText(b.bodyRaw, ct, cte).slice(0, 500);
    } catch (e) {
      excerpt = "";
    }
    return { id: msgId, from: from_, subject, date, excerpt, read: b.flags.includes("\\Seen") };
  });
}

/* ============ SERVIDOR HTTP ============ */
const server = http.createServer((req, res) => {
  let parsedReq;
  try {
    parsedReq = new URL(req.url, "http://127.0.0.1:" + PORT);
  } catch (e) {
    res.writeHead(400, corsHeaders());
    res.end("requisicao invalida");
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/ping") {
    res.writeHead(200, { ...corsHeaders(), "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/proxy") {
    const target = parsedReq.searchParams.get("url");
    if (!target) {
      res.writeHead(400, corsHeaders());
      res.end("faltou o parametro url");
      return;
    }
    let targetParsed;
    try {
      targetParsed = new URL(target);
    } catch (e) {
      res.writeHead(400, corsHeaders());
      res.end("url invalida");
      return;
    }
    if (targetParsed.protocol !== "https:" || !isAllowedHost(targetParsed.hostname, ALLOWED_PROXY_HOSTS)) {
      console.log(`[antena] proxy bloqueado — host nao permitido: ${targetParsed.hostname}`);
      res.writeHead(403, corsHeaders());
      res.end(
        "dominio nao liberado na antena. se voce confia nessa fonte, adicione '" +
          targetParsed.hostname +
          "' em ALLOWED_PROXY_HOSTS no server.js."
      );
      return;
    }
    console.log(`[antena] proxy -> ${targetParsed.hostname} (caminho oculto)`);
    fetchWithRedirects(target, 3, (err, result) => {
      if (err) {
        res.writeHead(502, corsHeaders());
        res.end("erro ao buscar: " + err.message);
        return;
      }
      res.writeHead(result.statusCode, {
        ...corsHeaders(),
        "content-type": result.headers["content-type"] || "text/plain; charset=utf-8"
      });
      res.end(result.body);
    });
    return;
  }

  if (req.method === "POST" && parsedReq.pathname === "/emails") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "json invalido" }));
        return;
      }
      const { host, usuario, senhaApp, quantidade } = payload || {};
      if (!host || !usuario || !senhaApp) {
        res.writeHead(400, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "faltam campos (host, usuario, senhaApp)" }));
        return;
      }
      if (!isAllowedHost(host, ALLOWED_IMAP_HOSTS)) {
        console.log(`[antena] IMAP bloqueado — host nao permitido: ${host}`);
        res.writeHead(403, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "host IMAP nao liberado. adicione '" + host + "' em ALLOWED_IMAP_HOSTS no server.js." }));
        return;
      }
      console.log(`[antena] IMAP ${host} usuario=${maskEmail(usuario)} senha=${maskSecret()}`);
      try {
        const emails = await fetchEmailsIMAP(host, usuario, senhaApp, quantidade);
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ emails }));
      } catch (e) {
        const msg = e.message === "LOGIN_FAILED" ? loginFailedMessage(host) : "erro ao conectar no IMAP: " + e.message;
        console.log(`[antena] erro IMAP (${host}): ${e.message}`);
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  // Boletim do Radar de Notícias (o sistema em ~/RadarDeNoticias).
  // Só lê o arquivo que o radar deixou — não busca nada na internet.
  if (req.method === "GET" && parsedReq.pathname === "/api/radar") {
    const arq = path.join(AGENT_STATE_DIR, "radar-boletim.json");
    try {
      const dados = lerJSON(arq);
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...dados }));
    } catch (e) {
      const semArquivo = e.code === "ENOENT";
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: false,
        error: semArquivo
          ? "O Radar ainda não gerou boletim. Rode 'radar' na pasta ~/RadarDeNoticias."
          : "não consegui ler o boletim: " + e.message
      }));
    }
    return;
  }

  /* Entrega o áudio do boletim pro navegador poder tocar.
     O arquivo mora fora daqui (~/RadarDeNoticias), e o navegador não abre
     caminho de disco a partir de http://. Só serve o arquivo que o próprio
     radar registrou — não aceita caminho vindo da URL, senão viraria uma
     porta pra ler qualquer arquivo da máquina. */
  // O vigia: quem está mudo ou falhando, e desde quando.
  if (req.method === "GET" && parsedReq.pathname === "/api/vigia") {
    let cfg = {};
    try { cfg = lerJSON(path.join(__dirname, "agents-config.json")); } catch { /* sem config */ }
    res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(avaliarVigia(cfg)));
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/api/radar/audio") {
    try {
      const meta = lerJSON(path.join(AGENT_STATE_DIR, "radar-boletim.json"));
      const arq = meta.audio;
      if (!arq || !fs.existsSync(arq)) {
        res.writeHead(404, corsHeaders());
        res.end("boletim sem áudio ainda");
        return;
      }
      const tipo = arq.toLowerCase().endsWith(".m4a") ? "audio/mp4" : "audio/wav";
      const stat = fs.statSync(arq);
      res.writeHead(200, { ...corsHeaders(), "content-type": tipo, "content-length": stat.size });
      fs.createReadStream(arq).pipe(res);
    } catch (e) {
      res.writeHead(404, corsHeaders());
      res.end("nenhum boletim gerado");
    }
    return;
  }

  /* A interface salva agendas/temas no localStorage do navegador, mas os
     AGENTES rodam aqui no servidor e leem do agents-config.json. Sem esta
     rota o agente de agenda ficaria desligado pra sempre, mesmo com o painel
     de Agenda funcionando — que era exatamente o que estava acontecendo. */
  if (req.method === "POST" && parsedReq.pathname === "/api/agents-config") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on("end", () => {
      try {
        const novo = JSON.parse(body);
        const atual = loadAgentsConfig();
        const cfg = {
          newsTopics: Array.isArray(novo.newsTopics) ? novo.newsTopics : (atual.newsTopics || []),
          calendars: Array.isArray(novo.calendars) ? novo.calendars : (atual.calendars || [])
        };
        fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(cfg, null, 2));
        console.log(`[agentes] config atualizada pela interface: ${cfg.calendars.length} agenda(s), ${cfg.newsTopics.length} tema(s)`);
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, calendars: cfg.calendars.length, newsTopics: cfg.newsTopics.length }));
      } catch (e) {
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/api/agents") {
    const cfg = loadAgentsConfig();
    const agents = AGENT_DEFS.map((def) => computeAgentSnapshot(def, cfg));
    const resumo = {
      total: agents.length,
      ok: agents.filter((a) => a.state === "ok").length,
      atencao: agents.filter((a) => a.state === "stale" || a.state === "error").length,
      off: agents.filter((a) => a.state === "off" || a.state === "idle").length,
      pior: (agents.find((a) => a.state === "error") || agents.find((a) => a.state === "stale") || {}).id || null
    };
    res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, now: new Date().toISOString(), agents, resumo }));
    return;
  }

  const runMatch = req.method === "POST" && /^\/api\/agents\/([a-z0-9-]+)\/run$/.exec(parsedReq.pathname);
  if (runMatch) {
    const def = AGENT_DEFS.find((d) => d.id === runMatch[1]);
    if (!def) {
      res.writeHead(404, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "agente nao encontrado" }));
      return;
    }
    console.log(`[agentes] disparo manual: ${def.id}`);
    def
      .run()
      .then(() => {
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((e) => {
        res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  /* Busca no segundo cérebro. Ex: /api/cerebro/buscar?q=comissao%20parceiro
     Devolve as notas relacionadas com score, área e cor — a mesma pontuação que
     o Claude Code usa no recall, então painel e agente enxergam a mesma coisa. */
  if (req.method === "GET" && parsedReq.pathname === "/api/cerebro/buscar") {
    const q = (parsedReq.searchParams.get("q") || "").trim();
    if (!q) {
      res.writeHead(400, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "informe ?q=" }));
      return;
    }
    chamarCerebro(["buscar", "--json", q], (err, json) => {
      // charset explícito: as notas têm acento, e sem isso o cliente decodifica como ANSI
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(err ? JSON.stringify({ ok: false, error: err.message }) : JSON.stringify(json));
    });
    return;
  }

  /* Saúde do cérebro, sem esperar a próxima rodada do agente. */
  /* Grafo do cofre (notas + ligações), pro Jarvis desenhar igual ao Obsidian.
     Quem monta é o CLI: as ligações moram no corpo das notas como [[wikilink]]
     e resolvê-las aqui duplicaria a regra em dois lugares. */
  /* Abre UMA nota pra leitura. O id vai como argumento pro CLI, que só aceita
     nota já presente no índice — então não há como pedir caminho arbitrário
     do disco por aqui. */
  if (req.method === "GET" && parsedReq.pathname === "/api/cerebro/nota") {
    const id = String(parsedReq.searchParams.get("id") || "").slice(0, 120);
    if (!/^[a-z0-9-]+$/i.test(id)) {
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "id inválido" }));
      return;
    }
    chamarCerebro(["ler", id], (err, json) => {
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(err ? JSON.stringify({ ok: false, error: err.message }) : JSON.stringify(json));
    });
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/api/cerebro/grafo") {
    chamarCerebro(["grafo"], (err, json) => {
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(err ? JSON.stringify({ ok: false, error: err.message }) : JSON.stringify(json));
    });
    return;
  }

  if (req.method === "GET" && parsedReq.pathname === "/api/cerebro/resumo") {
    chamarCerebro(["resumo"], (err, json) => {
      res.writeHead(200, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      res.end(err ? JSON.stringify({ ok: false, error: err.message }) : JSON.stringify(json));
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end("rota nao encontrada");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`\n⚠ A porta ${PORT} já está em uso. Feche o outro processo (ou outra instância do server.js) e tente de novo.\n`);
    process.exit(1);
  } else {
    console.log("Erro no servidor:", err.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n⚡ ANTENA DO JARVIS ONLINE — porta ${PORT}. Pode abrir o jarvis.html.\n`);
  // agentes autônomos: primeira rodada logo após subir, depois no intervalo próprio de cada um
  setTimeout(() => runNewsAgent().catch((e) => console.log("[agentes] erro news-radar:", e.message)), 2000);
  setTimeout(() => runAgendaAgent().catch((e) => console.log("[agentes] erro agenda-sync:", e.message)), 2500);
  setTimeout(() => runCerebroAgent().catch((e) => console.log("[agentes] erro cerebro-sync:", e.message)), 3000);
  setInterval(() => runNewsAgent().catch((e) => console.log("[agentes] erro news-radar:", e.message)), NEWS_AGENT_EVERY_MIN * 60 * 1000);
  setInterval(() => runAgendaAgent().catch((e) => console.log("[agentes] erro agenda-sync:", e.message)), AGENDA_AGENT_EVERY_MIN * 60 * 1000);
  setInterval(() => runCerebroAgent().catch((e) => console.log("[agentes] erro cerebro-sync:", e.message)), CEREBRO_AGENT_EVERY_MIN * 60 * 1000);

  // O vigia roda DEPOIS da primeira rodada dos agentes: perguntar antes disso
  // marcaria todo mundo como "nunca rodou" a cada reinício da antena.
  setTimeout(rodarVigia, 20000);
  setInterval(rodarVigia, VIGIA_EVERY_MIN * 60 * 1000);
});
