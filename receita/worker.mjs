const MODELO_PADRAO = "claude-sonnet-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSAO_API = "2023-06-01";
const TIMEOUT_MS = 12e4;
class ErroAnthropic extends Error {
  status;
  constructor(mensagem, status) {
    super(mensagem);
    this.name = "ErroAnthropic";
    this.status = status;
  }
}
async function chamarComFerramenta(opcoes) {
  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  let resposta;
  try {
    resposta = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opcoes.apiKey,
        "anthropic-version": VERSAO_API
      },
      signal: controlador.signal,
      body: JSON.stringify({
        model: opcoes.modelo || MODELO_PADRAO,
        max_tokens: opcoes.maxTokens ?? 8192,
        tools: [opcoes.ferramenta],
        tool_choice: { type: "tool", name: opcoes.ferramenta.name },
        messages: [{ role: "user", content: opcoes.conteudo }]
      })
    });
  } catch (e) {
    const abortou = e instanceof Error && e.name === "AbortError";
    throw new ErroAnthropic(
      abortou ? "tempo esgotado ao falar com o modelo" : "falha de rede ao falar com o modelo",
      504
    );
  } finally {
    clearTimeout(relogio);
  }
  if (!resposta.ok) {
    let tipo = "";
    try {
      const j = await resposta.json();
      tipo = j?.error?.type ?? "";
    } catch {
    }
    throw new ErroAnthropic(
      `modelo respondeu ${resposta.status}${tipo ? ` (${tipo})` : ""}`,
      resposta.status
    );
  }
  const corpo = await resposta.json();
  const bloco = corpo.content?.find(
    (b) => b.type === "tool_use" && b.name === opcoes.ferramenta.name
  );
  if (!bloco || typeof bloco.input !== "object" || bloco.input === null) {
    throw new ErroAnthropic("o modelo não devolveu dados estruturados", 502);
  }
  return bloco.input;
}
function blocosDeImagem(imagens) {
  const blocos = [];
  for (const img of imagens) {
    blocos.push({ type: "text", text: `Foto — ${img.label}:` });
    blocos.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data }
    });
  }
  return blocos;
}
const DESPENSA_PADRAO = [
  "Arroz",
  "Feijão",
  "Massa",
  "Azeite",
  "Alho",
  "Sal e pimenta"
];
function inventarioDemo() {
  return [
    {
      id: "item-1",
      nome: "Rúcula",
      status: "identificado",
      categoria: "Folhas",
      quantidade_faixa: "½–1 maço",
      confianca: 0.96,
      origem_foto: "Prateleiras"
    },
    {
      id: "item-2",
      nome: "Morangos",
      status: "identificado",
      categoria: "Frutas",
      quantidade_faixa: "200–300 g",
      confianca: 0.91,
      origem_foto: "Gaveta aberta"
    },
    {
      id: "item-3",
      nome: "Cogumelos",
      status: "identificado",
      categoria: "Hortifruti",
      quantidade_faixa: "150–250 g",
      confianca: 0.88,
      origem_foto: "Gaveta aberta"
    },
    {
      id: "item-4",
      nome: "Ovos",
      status: "identificado",
      categoria: "Proteínas",
      quantidade_faixa: "6–10 unidades",
      confianca: 0.97,
      origem_foto: "Porta"
    },
    {
      id: "item-5",
      nome: "Iogurte natural",
      status: "identificado",
      categoria: "Laticínios",
      quantidade_faixa: "1 pote de 500 g, aberto",
      confianca: 0.85,
      origem_foto: "Prateleiras"
    },
    {
      id: "item-6",
      nome: "Item em pote opaco",
      status: "incerto",
      descricao_visual: "Pote plástico branco com tampa azul; conteúdo não visível",
      categoria: "Incerto",
      quantidade_faixa: "1 pote médio",
      confianca: 0.28,
      origem_foto: "Prateleiras"
    }
  ];
}
const LIVRO = [
  {
    ordem: 1,
    titulo: "Frittata de cogumelos e rúcula",
    descricao: "Uma frigideira só, folhas frescas e cogumelos dourados.",
    tempo_minutos: 22,
    rendimento: "2 porções",
    urgencia: "hoje",
    motivo_ordem: "Rúcula e cogumelos perdem textura primeiro — a rúcula murcha em dois dias e o cogumelo escurece antes disso.",
    usa: ["Rúcula", "Cogumelos", "Ovos"],
    ingredientes: [
      { nome: "Cogumelos frescos", quantidade: "150 g, fatiados em lâminas de ½ cm" },
      { nome: "Rúcula", quantidade: "½ maço, folhas separadas" },
      { nome: "Ovos", quantidade: "4 unidades" },
      { nome: "Alho", quantidade: "1 dente pequeno, picado" },
      { nome: "Azeite", quantidade: "2 colheres (sopa)" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Lave a rúcula em água corrente, seque bem — folha molhada solta água na frigideira e desanda a frittata — e separe as folhas. Fatie os cogumelos em lâminas de aproximadamente ½ cm.",
      "Quebre os ovos em uma tigela, tempere com sal e pimenta e bata por 30 segundos com um garfo, apenas até clara e gema se misturarem. Não bata além disso: ar demais deixa a frittata borrachuda.",
      "Aqueça uma frigideira antiaderente de 22 cm em fogo alto por 1 minuto. Junte 1 colher de azeite e espalhe os cogumelos em camada única, sem amontoar.",
      "Doure os cogumelos por 4–5 minutos, mexendo somente duas vezes. Estão prontos quando ficarem marrons nas bordas e não houver mais líquido no fundo da panela.",
      "Abaixe para fogo médio, junte o alho e refogue por 30 segundos, só até perfumar — alho queimado amarga a receita inteira.",
      "Acrescente o azeite restante e despeje os ovos por cima. Distribua metade da rúcula, tampe e cozinhe em fogo baixo por 5–7 minutos, até as bordas firmarem e o centro ainda balançar levemente quando você sacode a panela.",
      "Desligue e deixe tampado por 2 minutos: o calor residual termina o centro sem ressecar. Finalize com a rúcula restante e corte em fatias."
    ],
    dica_cozinheiro: "Se os cogumelos soltarem água, mantenha o fogo alto até o líquido evaporar por completo antes de adicionar os ovos — senão a frittata cozinha no vapor e não dora."
  },
  {
    ordem: 2,
    titulo: "Panquecas de iogurte com morangos",
    descricao: "Massa de uma tigela, morangos macerados por cima.",
    tempo_minutos: 20,
    rendimento: "2 porções",
    urgencia: "hoje",
    motivo_ordem: "Morango é fruta vermelha: amassa e mofa rápido, e um único fruto estragado contamina a caixa toda.",
    usa: ["Morangos", "Iogurte natural", "Ovos"],
    ingredientes: [
      { nome: "Morangos", quantidade: "200 g, sem cabinho, cortados ao meio" },
      { nome: "Iogurte natural", quantidade: "1 xícara (200 g)" },
      { nome: "Ovos", quantidade: "2 unidades" },
      { nome: "Farinha de trigo", quantidade: "1 xícara (120 g)" },
      { nome: "Açúcar", quantidade: "3 colheres (sopa), sendo 1 para os morangos" },
      { nome: "Fermento em pó", quantidade: "1 colher (chá)" },
      { nome: "Azeite", quantidade: "1 colher (chá), para untar" }
    ],
    passos: [
      "Lave os morangos, tire os cabinhos e corte ao meio. Misture com 1 colher de açúcar em uma tigela pequena e deixe descansando enquanto faz a massa — em 15 minutos eles soltam uma calda natural.",
      "Em outra tigela, misture a farinha, o restante do açúcar e o fermento com um garfo, para desfazer os grumos secos.",
      "Junte o iogurte e os ovos aos secos e misture apenas até sumir a farinha seca. A massa deve ficar grossa e com alguns caroços — mexer até ficar lisa desenvolve glúten e endurece a panqueca.",
      "Aqueça uma frigideira antiaderente em fogo médio-baixo por 2 minutos e passe o azeite com papel-toalha, deixando só um brilho.",
      "Despeje porções de 2 colheres (sopa) da massa. Cozinhe por 2–3 minutos, até a superfície ficar coberta de bolhas que estouram e não se fecham mais — esse é o sinal para virar.",
      "Vire e cozinhe por mais 1–2 minutos, até dourar do outro lado. Repita com o restante da massa, mantendo o fogo médio-baixo: fogo alto doura fora e deixa cru dentro.",
      "Sirva as panquecas empilhadas com os morangos e toda a calda que se formou na tigela."
    ],
    dica_cozinheiro: "Deixe a massa descansar 5 minutos antes de usar: o fermento começa a agir e as panquecas crescem mais altas."
  },
  {
    ordem: 3,
    titulo: "Bowl morno com molho de iogurte",
    descricao: "Arroz quente, ovo mole e um molho ácido que amarra tudo.",
    tempo_minutos: 15,
    rendimento: "2 porções",
    urgencia: "em_breve",
    motivo_ordem: "O iogurte já está aberto — pote aberto dura poucos dias, bem menos que o prazo impresso na tampa.",
    usa: ["Iogurte natural", "Rúcula", "Ovos"],
    ingredientes: [
      { nome: "Arroz cozido", quantidade: "2 xícaras (do arroz da despensa, já pronto)" },
      { nome: "Iogurte natural", quantidade: "½ xícara (100 g)" },
      { nome: "Ovos", quantidade: "2 unidades" },
      { nome: "Rúcula", quantidade: "½ maço" },
      { nome: "Alho", quantidade: "1 dente pequeno, amassado" },
      { nome: "Azeite", quantidade: "1 colher (sopa)" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Misture o iogurte, o alho amassado, o azeite, sal e pimenta em uma tigela pequena. Prove e reserve — o molho fica melhor se descansar enquanto o resto cozinha.",
      "Ferva 1 litro de água numa panela pequena em fogo alto. Quando estiver borbulhando forte, abaixe para fogo médio, até a água mexer sem espirrar.",
      "Baixe os ovos com uma escumadeira e conte 6 minutos exatos para gema mole, ou 8 minutos para gema cremosa. Transfira imediatamente para água gelada e deixe 1 minuto: isso para o cozimento e solta a casca.",
      "Enquanto os ovos cozinham, aqueça o arroz em uma frigideira em fogo médio por 3–4 minutos, mexendo de vez em quando, só até soltar vapor e os grãos se separarem.",
      "Lave e seque a rúcula. Monte cada tigela com o arroz quente por baixo e as folhas por cima — o calor do arroz murcha levemente a rúcula, que é o ponto certo.",
      "Descasque os ovos, corte ao meio e apoie sobre o arroz. Regue tudo com o molho de iogurte e finalize com pimenta moída na hora."
    ],
    dica_cozinheiro: "Se o molho ficar grosso demais, abra com 1 colher de água gelada por vez até escorrer da colher em fio contínuo."
  },
  {
    ordem: 4,
    titulo: "Arroz crocante com ovo",
    descricao: "A crosta dourada do fundo da panela é o prato inteiro.",
    tempo_minutos: 18,
    rendimento: "2 porções",
    urgencia: "em_breve",
    motivo_ordem: "Ovo fechado aguenta semanas, mas aqui ele resolve o arroz que já está cozido e não deve ficar mais dias na geladeira.",
    usa: ["Ovos"],
    ingredientes: [
      { nome: "Arroz cozido", quantidade: "2½ xícaras, frio e soltinho" },
      { nome: "Ovos", quantidade: "3 unidades" },
      { nome: "Alho", quantidade: "2 dentes, picados" },
      { nome: "Azeite", quantidade: "3 colheres (sopa)" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Solte o arroz frio com as mãos ou um garfo, desfazendo todos os torrões. Arroz empelotado não encosta na panela por igual e não forma crosta.",
      "Aqueça uma frigideira de 24 cm em fogo médio-alto por 2 minutos. Junte 2 colheres de azeite e o alho, e mexa por 20 segundos, só até começar a dourar nas beiradas.",
      "Espalhe o arroz em camada uniforme, pressionando com as costas de uma espátula para encostar bem no fundo. Tempere com sal e pimenta.",
      "Agora não mexa por 5–6 minutos. Você vai ouvir um chiado constante e sentir cheiro de tostado; quando levantar uma beirada com a espátula e ela estiver marrom-dourada, a crosta está formada.",
      "Empurre o arroz para um lado da frigideira, junte o azeite restante no espaço livre e quebre os ovos ali. Tempere e frite por 2–3 minutos, até a clara ficar opaca e firme e a gema ainda tremer.",
      "Sirva raspando bem o fundo com a espátula para levar a crosta junto, com o ovo por cima e pimenta moída na hora."
    ],
    dica_cozinheiro: "Arroz da geladeira funciona melhor que arroz recém-feito: ele perdeu umidade e por isso frita em vez de cozinhar no próprio vapor."
  },
  {
    ordem: 5,
    titulo: "Massa dourada com alho",
    descricao: "Alho tostado devagar no azeite, massa e nada mais.",
    tempo_minutos: 20,
    rendimento: "2 porções",
    urgencia: "pode_esperar",
    motivo_ordem: "Massa seca e alho ficam meses na despensa — podem esperar o fim da semana sem risco nenhum.",
    usa: [],
    ingredientes: [
      { nome: "Massa seca", quantidade: "200 g" },
      { nome: "Alho", quantidade: "4 dentes, fatiados finos" },
      { nome: "Azeite", quantidade: "4 colheres (sopa)" },
      { nome: "Água para a massa", quantidade: "2 litros" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Ferva 2 litros de água em fogo alto numa panela grande e salgue bem — a água deve ficar visivelmente salgada, porque é o único momento de temperar a massa por dentro.",
      "Enquanto a água esquenta, fatie o alho em lâminas finas. Fatia fina tosta por igual; alho picado queima em pontos e amarga.",
      "Cozinhe a massa pelo tempo da embalagem menos 2 minutos. Reserve 1 xícara da água do cozimento antes de escorrer — é ela que vai emulsionar o molho.",
      "Em paralelo, aqueça o azeite e o alho juntos numa frigideira larga em fogo BAIXO. Começar frio é o segredo: o alho tosta devagar em 5–6 minutos e fica dourado e doce, em vez de queimar por fora.",
      "Quando as lâminas estiverem cor de mel e crocantes, desligue o fogo — elas continuam tostando no azeite quente.",
      "Junte a massa escorrida à frigideira com ½ xícara da água reservada e volte ao fogo médio. Mexa e sacuda a panela por 1–2 minutos, até o líquido virar um molho brilhante que gruda na massa. Acrescente mais água aos poucos se secar demais.",
      "Sirva imediatamente, com pimenta moída na hora e as lâminas de alho espalhadas por cima para não perderem a crocância."
    ],
    dica_cozinheiro: "Se o alho escurecer rápido demais, tire a frigideira do fogo por 30 segundos — a queda de temperatura salva o azeite antes que ele fique amargo."
  },
  {
    ordem: 6,
    titulo: "Creme de feijão com torradas de alho",
    descricao: "Feijão batido até virar veludo, com pão tostado no azeite.",
    tempo_minutos: 30,
    rendimento: "2 porções",
    urgencia: "pode_esperar",
    motivo_ordem: "Feijão cozido e pão são os itens mais estáveis do plano — seguram o fim da semana sem pressa.",
    usa: [],
    ingredientes: [
      { nome: "Feijão cozido", quantidade: "2 xícaras, com um pouco do caldo" },
      { nome: "Alho", quantidade: "3 dentes, sendo 2 picados e 1 inteiro" },
      { nome: "Azeite", quantidade: "3 colheres (sopa)" },
      { nome: "Água quente", quantidade: "1 xícara, para ajustar" },
      { nome: "Pão", quantidade: "4 fatias" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Aqueça 2 colheres de azeite numa panela média em fogo médio e refogue os 2 dentes de alho picados por 40 segundos, até perfumar e ficar levemente dourado nas bordas.",
      "Junte o feijão cozido com um pouco do caldo e cozinhe por 5 minutos, mexendo de vez em quando, para os sabores se juntarem.",
      "Bata tudo com mixer, ou passe pelo liquidificador em duas levas, até virar um creme liso. Se estiver muito espesso, vá abrindo com a água quente, ¼ de xícara por vez, até ficar na consistência de mingau grosso que escorre lento da colher.",
      "Volte o creme à panela, tempere com sal e pimenta e cozinhe em fogo baixo por 5 minutos, mexendo sempre — creme de feijão gruda no fundo e queima com facilidade.",
      "Enquanto isso, toste as fatias de pão numa frigideira seca em fogo médio por 2 minutos de cada lado, até firmarem e ficarem com marcas douradas.",
      "Esfregue o dente de alho inteiro na superfície ainda quente de cada torrada — o pão áspero rala o alho e distribui o sabor — e regue com o azeite restante.",
      "Sirva o creme em tigelas fundas com as torradas ao lado e um fio de azeite por cima."
    ],
    dica_cozinheiro: "O creme engrossa bastante ao esfriar. Se sobrar, reaqueça com um pouco de água quente e mexa até voltar ao ponto."
  },
  {
    ordem: 7,
    titulo: "Arroz e feijão de uma panela",
    descricao: "Tudo na mesma panela, com crosta dourada no fundo.",
    tempo_minutos: 35,
    rendimento: "2 porções",
    urgencia: "pode_esperar",
    motivo_ordem: "Arroz e feijão da despensa são os últimos a estragar — fecham a semana quando a geladeira já esvaziou.",
    usa: [],
    ingredientes: [
      { nome: "Arroz", quantidade: "1 xícara, cru e lavado" },
      { nome: "Feijão cozido", quantidade: "1½ xícara, escorrido" },
      { nome: "Alho", quantidade: "3 dentes, picados" },
      { nome: "Azeite", quantidade: "3 colheres (sopa)" },
      { nome: "Água quente", quantidade: "2 xícaras" },
      { nome: "Sal e pimenta-do-reino", quantidade: "a gosto" }
    ],
    passos: [
      "Lave o arroz em água corrente até a água sair quase transparente, e escorra bem. Tirar o amido da superfície é o que impede o prato de virar papa.",
      "Aqueça 2 colheres de azeite numa panela de fundo grosso em fogo médio e refogue o alho por 40 segundos, até dourar nas bordas sem escurecer no centro.",
      "Junte o arroz escorrido e mexa por 2 minutos, até os grãos ficarem brilhantes de azeite e levemente opacos — esse selamento ajuda a manter o grão solto.",
      "Adicione a água quente e o sal, aumente para fogo alto e espere levantar fervura. Então abaixe para o mínimo, tampe e cozinhe por 15 minutos sem abrir a panela nenhuma vez.",
      "Destampe, espalhe o feijão por cima sem misturar, tampe de novo e deixe mais 3 minutos, só para o feijão aquecer no vapor.",
      "Regue com o azeite restante pelas bordas, suba para fogo médio-alto e deixe 3–4 minutos sem mexer: você vai ouvir um estalo seco quando a crosta se formar no fundo.",
      "Desligue, deixe descansar tampado por 5 minutos e só então misture tudo, raspando o fundo para trazer a parte tostada junto."
    ],
    dica_cozinheiro: "Panela de fundo grosso é o que faz a crosta sem queimar. Em panela fina, reduza para fogo médio na última etapa e acompanhe pelo cheiro."
  }
];
function cardapioDemo(meals, maxTime) {
  const cabem = LIVRO.filter((m) => m.tempo_minutos <= maxTime);
  const escolhidas = cabem.slice(0, meals).map((m, i) => ({ ...m, ordem: i + 1 }));
  const faltou = escolhidas.length < meals;
  const resumo = faltou ? `Comece pelas folhas e cogumelos, que vencem primeiro. O exemplo tem ${escolhidas.length} receita(s) dentro de ${maxTime} minutos — suba o tempo máximo para ver a semana inteira.` : "Comece pelas folhas e cogumelos. Morangos logo depois, e o iogurte aberto antes que passe. Ovos e itens secos sustentam o fim da semana.";
  const compras = [];
  const precisaFarinha = escolhidas.some((m) => m.titulo.includes("Panquecas"));
  const precisaPao = escolhidas.some((m) => m.titulo.includes("torradas"));
  if (precisaFarinha) compras.push("Farinha de trigo", "Açúcar", "Fermento em pó");
  if (precisaPao) compras.push("Pão");
  return { resumo, refeicoes: escolhidas, compras };
}
const LIMITE = 80;
const PREFIXO = "despensa:";
const COOKIE = "receita_id";
const UM_ANO = 60 * 60 * 24 * 365;
class DepositoKV {
  constructor(kv) {
    this.kv = kv;
  }
  persistente = true;
  async ler(id) {
    const v = await this.kv.get(PREFIXO + id, "json");
    return Array.isArray(v) ? v : null;
  }
  async gravar(id, itens) {
    await this.kv.put(PREFIXO + id, JSON.stringify(itens));
  }
}
class DepositoMemoria {
  persistente = false;
  mapa = /* @__PURE__ */ new Map();
  async ler(id) {
    return this.mapa.get(id) ?? null;
  }
  async gravar(id, itens) {
    this.mapa.set(id, itens);
  }
}
const memoriaCompartilhada = new DepositoMemoria();
function abrirDespensa(kv) {
  if (kv && typeof kv.get === "function") {
    return new DepositoKV(kv);
  }
  return memoriaCompartilhada;
}
function lerId(req) {
  const cru = req.headers.get("cookie");
  if (!cru) return null;
  for (const parte of cru.split(";")) {
    const [k, v] = parte.trim().split("=");
    if (k === COOKIE && v && /^[a-z0-9]{8,64}$/i.test(v)) return v;
  }
  return null;
}
function novoId() {
  return crypto.randomUUID().replace(/-/g, "");
}
function cabecalhoCookie(id) {
  return `${COOKIE}=${id}; Path=/; Max-Age=${UM_ANO}; HttpOnly; SameSite=Lax; Secure`;
}
function limparLista(bruto) {
  if (!Array.isArray(bruto)) return [];
  const saida = [];
  const vistos = /* @__PURE__ */ new Set();
  for (const cru of bruto) {
    if (typeof cru !== "string") continue;
    const nome = cru.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!nome) continue;
    const chave = nome.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(nome);
    if (saida.length >= LIMITE) break;
  }
  return saida;
}
const CATEGORIAS = [
  "Folhas",
  "Hortifruti",
  "Frutas",
  "Proteínas",
  "Laticínios",
  "Bebidas",
  "Molhos",
  "Sobras",
  "Incerto",
  "Outro"
];
const URGENCIAS = ["hoje", "em_breve", "pode_esperar"];
const FERRAMENTA_INVENTARIO = {
  name: "registrar_inventario",
  description: "Registra o inventário de alimentos visíveis nas fotos da geladeira.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Um item por alimento visível, já consolidado entre as fotos.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Identificador curto e único, ex: item-1" },
            nome: { type: "string" },
            status: { type: "string", enum: ["identificado", "incerto"] },
            descricao_visual: {
              type: "string",
              description: "Somente para status incerto: o que se vê, sem chutar o conteúdo."
            },
            categoria: { type: "string", enum: [...CATEGORIAS] },
            quantidade_faixa: {
              type: "string",
              description: "Faixa visual aproximada, ex: 300–600 g, 4–6 unidades, ½–1 maço"
            },
            confianca: { type: "number", minimum: 0, maximum: 1 },
            origem_foto: {
              type: "string",
              enum: ["Prateleiras", "Gaveta aberta", "Porta"]
            }
          },
          required: ["id", "nome", "status", "categoria", "quantidade_faixa", "confianca"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};
const FERRAMENTA_CARDAPIO = {
  name: "registrar_cardapio",
  description: "Registra o cardápio ordenado por perecibilidade, com receitas completas.",
  input_schema: {
    type: "object",
    properties: {
      resumo: { type: "string" },
      refeicoes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ordem: { type: "integer", minimum: 1 },
            titulo: { type: "string" },
            descricao: { type: "string" },
            tempo_minutos: { type: "integer", minimum: 1 },
            rendimento: { type: "string" },
            urgencia: { type: "string", enum: [...URGENCIAS] },
            motivo_ordem: { type: "string" },
            usa: { type: "array", items: { type: "string" } },
            ingredientes: {
              type: "array",
              minItems: 2,
              description: "TUDO que a receita usa, com quantidade útil em cada linha.",
              items: {
                type: "object",
                properties: {
                  nome: { type: "string" },
                  quantidade: { type: "string" }
                },
                required: ["nome", "quantidade"],
                additionalProperties: false
              }
            },
            passos: {
              type: "array",
              minItems: 5,
              maxItems: 8,
              description: "Cada passo é um parágrafo com corte, fogo, tempo e sinal de ponto.",
              items: { type: "string" }
            },
            dica_cozinheiro: { type: "string" }
          },
          required: [
            "ordem",
            "titulo",
            "descricao",
            "tempo_minutos",
            "rendimento",
            "urgencia",
            "motivo_ordem",
            "usa",
            "ingredientes",
            "passos",
            "dica_cozinheiro"
          ],
          additionalProperties: false
        }
      },
      compras: { type: "array", items: { type: "string" } }
    },
    required: ["resumo", "refeicoes", "compras"],
    additionalProperties: false
  }
};
const PROMPT_INVENTARIO = `Analise as três fotos como um único inventário de geladeira.

REGRAS INEGOCIÁVEIS:

- Liste somente alimentos que estejam realmente visíveis.
- Nunca infira ingredientes escondidos.
- Nunca presuma o conteúdo de potes opacos.
- Nunca presuma o que existe atrás de outros objetos.
- Não identifique um alimento apenas pela cor do recipiente.
- Quando o item não puder ser identificado, use status 'incerto'.
- Para itens incertos, descreva somente as características visíveis em descricao_visual.
- Nunca chute o conteúdo.
- Quantidades devem ser faixas visuais aproximadas.
- Nunca invente peso ou quantidade exata.
- Exemplos válidos: '300–600 g', '4–6 unidades', '½–1 maço'.
- Confiança deve ser um número entre 0 e 1.
- Diminua a confiança quando rótulo, conteúdo ou embalagem estiver parcial.
- Consolide itens duplicados vistos em mais de uma foto.
- Não conte o mesmo produto duas vezes.
- Ignore objetos que não sejam alimentos.
- Escreva em português do Brasil.
- Gere IDs curtos e únicos.`;
function promptCardapio(refeicoes, maxTime, inventario, despensa) {
  return `Crie um cardápio de ${refeicoes} refeições, cada uma com no máximo ${maxTime} minutos.

INVENTÁRIO CONFIRMADO PELO USUÁRIO:
${JSON.stringify(inventario, null, 2)}

DESPENSA DISPONÍVEL:
${JSON.stringify(despensa, null, 2)}

OBJETIVO PRINCIPAL:

Ordene as refeições pela perecibilidade real dos alimentos. A primeira refeição deve consumir os itens que estragam primeiro. A última pode usar os itens mais estáveis.

Não basta sugerir pratos. Entregue receitas completas e executáveis.

REGRAS DE INVENTÁRIO:

- Use somente itens identificados ou corrigidos pelo usuário.
- Ignore todo item com status 'incerto'.
- Respeite as faixas de quantidade.
- Não use o mesmo ingrediente em volume maior do que o disponível.
- Não invente ingredientes como se estivessem disponíveis.
- Ingredientes ausentes e obrigatórios devem entrar na lista de compras.
- Não repita nas compras algo já presente na geladeira ou despensa.

REGRAS DE PERECIBILIDADE:

- Folhas, ervas, cogumelos, frutas vermelhas, frutas maduras, itens cortados e produtos abertos devem aparecer primeiro.
- Iogurtes, queijos abertos e legumes macios entram depois.
- Ovos fechados, raízes firmes, congelados, arroz, feijão e massas secas podem esperar.
- Explique em motivo_ordem por que cada receita aparece naquela posição.

REGRAS DE RECEITA:

- Cada receita deve render 2 porções.
- Cada receita deve ser completa o suficiente para cozinhar sem consultar outra fonte.
- Liste todos os ingredientes utilizados.
- Inclua quantidades úteis.
- Inclua água, gordura, sal e temperos quando forem usados.
- Use 'a gosto' apenas para sal, pimenta ou finalizações opcionais.
- Crie de 5 a 8 passos detalhados.
- Siga a ordem real de execução.
- Explique cortes, fogo, tempo, textura, aparência e ponto de cocção.
- Inclua tempo aproximado nas etapas importantes.
- Nunca escreva apenas 'prepare', 'cozinhe', 'misture' ou 'finalize' sem explicar como.
- O tempo total inclui preparo e cocção.
- O tempo total não pode ultrapassar ${maxTime} minutos.
- dica_cozinheiro deve trazer uma dica prática de ponto, conservação ou substituição.
- A dica não pode introduzir outro ingrediente obrigatório.
- Gere receitas variadas, simples e realistas.
- Escreva em português do Brasil.
- Retorne exatamente ${refeicoes} refeições em ordem crescente.`;
}
const LIMITE_ITENS = 60;
const LIMITE_PASSOS = 8;
const MINIMO_PASSOS = 5;
class ErroValidacao extends Error {
}
function texto(v, max = 600) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function inteiroPositivo(v, padrao) {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : padrao;
}
function validarInventario(bruto) {
  const lista = bruto?.items;
  if (!Array.isArray(lista)) throw new ErroValidacao("inventário sem lista de itens");
  const vistos = /* @__PURE__ */ new Set();
  const saida = [];
  for (const cru of lista.slice(0, LIMITE_ITENS)) {
    if (typeof cru !== "object" || cru === null) continue;
    const o = cru;
    const nome = texto(o.nome, 120);
    if (!nome) continue;
    const status = o.status === "incerto" ? "incerto" : "identificado";
    const categoriaCrua = texto(o.categoria, 40);
    const categoria = CATEGORIAS.includes(categoriaCrua) ? categoriaCrua : status === "incerto" ? "Incerto" : "Outro";
    const c = typeof o.confianca === "number" ? o.confianca : 0.5;
    const confianca = Math.min(1, Math.max(0, Number.isFinite(c) ? c : 0.5));
    let id = texto(o.id, 40) || `item-${saida.length + 1}`;
    while (vistos.has(id)) id = `${id}-${saida.length + 1}`;
    vistos.add(id);
    const item = {
      id,
      nome,
      status,
      categoria,
      quantidade_faixa: texto(o.quantidade_faixa, 80) || "quantidade não estimada",
      confianca
    };
    const desc = texto(o.descricao_visual, 300);
    if (desc) item.descricao_visual = desc;
    const origem = texto(o.origem_foto, 40);
    if (origem === "Prateleiras" || origem === "Gaveta aberta" || origem === "Porta") {
      item.origem_foto = origem;
    }
    saida.push(item);
  }
  return saida;
}
function normalizar(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const RUIDO = /* @__PURE__ */ new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "ou",
  "com",
  "sem",
  "a",
  "o",
  "as",
  "os",
  "em",
  "no",
  "na",
  "um",
  "uma",
  "fresco",
  "frescos",
  "fresca",
  "frescas",
  "picado",
  "picada",
  "picados",
  "picadas",
  "fatiado",
  "fatiada",
  "fatiados",
  "ralado",
  "ralada",
  "cortado",
  "cortada",
  "grande",
  "pequeno",
  "pequena",
  "medio",
  "media",
  "gosto",
  "unidade",
  "unidades",
  "colher",
  "colheres",
  "xicara",
  "xicaras",
  "sopa",
  "cha",
  "dente",
  "dentes",
  "maco",
  "macos",
  "pote",
  "potes",
  "lata",
  "latas",
  "g",
  "kg",
  "ml",
  "l",
  "quente",
  "frio",
  "natural",
  "integral",
  "opcional",
  "extra",
  "virgem"
]);
function radical(p) {
  let r = p;
  if (r.endsWith("oes")) r = r.slice(0, -3) + "ao";
  else if (r.endsWith("aes")) r = r.slice(0, -3) + "ao";
  else if (r.endsWith("ais")) r = r.slice(0, -3) + "al";
  else if (r.endsWith("eis")) r = r.slice(0, -3) + "el";
  else if (r.endsWith("ns")) r = r.slice(0, -2) + "m";
  else if (r.endsWith("s") && r.length > 3) r = r.slice(0, -1);
  return r;
}
function chaves(s) {
  const out = /* @__PURE__ */ new Set();
  for (const p of normalizar(s).split(" ")) {
    if (!p || RUIDO.has(p) || p.length < 3) continue;
    if (/^\d+$/.test(p)) continue;
    out.add(radical(p));
  }
  return out;
}
function combina(a, b) {
  const ka = chaves(a);
  const kb = chaves(b);
  if (!ka.size || !kb.size) return false;
  for (const k of ka) if (kb.has(k)) return true;
  return false;
}
const NUNCA_COMPRAR = ["agua", "sal", "pimenta", "gelo"];
function eBasico(nome) {
  const n = normalizar(nome);
  return NUNCA_COMPRAR.some((b) => n.includes(b));
}
function validarIngredientes(bruto) {
  if (!Array.isArray(bruto)) return [];
  const saida = [];
  for (const cru of bruto.slice(0, 30)) {
    if (typeof cru !== "object" || cru === null) continue;
    const o = cru;
    const nome = texto(o.nome, 120);
    const quantidade = texto(o.quantidade, 120);
    if (!nome || !quantidade) continue;
    saida.push({ nome, quantidade });
  }
  return saida;
}
function validarRefeicao(bruto, maxTime) {
  if (typeof bruto !== "object" || bruto === null) return null;
  const o = bruto;
  const titulo = texto(o.titulo, 140);
  if (!titulo) return null;
  const ingredientes = validarIngredientes(o.ingredientes);
  if (ingredientes.length < 2) return null;
  const passosCrus = Array.isArray(o.passos) ? o.passos : [];
  const passos = passosCrus.map((p) => texto(p, 900)).filter((p) => p.length > 0).slice(0, LIMITE_PASSOS);
  if (passos.length < MINIMO_PASSOS) return null;
  const urgenciaCrua = texto(o.urgencia, 20);
  const urgencia = URGENCIAS.includes(urgenciaCrua) ? urgenciaCrua : "em_breve";
  const usa = Array.isArray(o.usa) ? o.usa.map((u) => texto(u, 80)).filter(Boolean).slice(0, 12) : [];
  return {
    ordem: inteiroPositivo(o.ordem, 1),
    titulo,
    descricao: texto(o.descricao, 300),
    // Tempo maior que o pedido e quebra de contrato com o usuario, que
    // escolheu o limite na tela anterior. Fica preso no teto.
    tempo_minutos: Math.min(maxTime, inteiroPositivo(o.tempo_minutos, maxTime)),
    rendimento: texto(o.rendimento, 60) || "2 porções",
    urgencia,
    motivo_ordem: texto(o.motivo_ordem, 300),
    usa,
    ingredientes,
    passos,
    dica_cozinheiro: texto(o.dica_cozinheiro, 400)
  };
}
const PESO_URGENCIA = {
  hoje: 0,
  em_breve: 1,
  pode_esperar: 2
};
function reconciliarCompras(refeicoes, inventario, despensa, comprasDoModelo) {
  const disponivel = [
    ...inventario.filter((i) => i.status === "identificado").map((i) => i.nome),
    ...despensa
  ];
  const temEmCasa = (nome) => disponivel.some((d) => combina(nome, d));
  const compras = [];
  const jaNaLista = (nome) => compras.some((c) => combina(nome, c));
  for (const c of comprasDoModelo) {
    const nome = texto(c, 120);
    if (!nome || eBasico(nome) || temEmCasa(nome) || jaNaLista(nome)) continue;
    compras.push(nome);
  }
  for (const r of refeicoes) {
    for (const ing of r.ingredientes) {
      if (eBasico(ing.nome) || temEmCasa(ing.nome) || jaNaLista(ing.nome)) continue;
      compras.push(ing.nome);
    }
  }
  return compras.slice(0, 20);
}
function validarCardapio(bruto, pedido) {
  const o = bruto;
  const cruas = Array.isArray(o?.refeicoes) ? o.refeicoes : [];
  const validas = [];
  for (const c of cruas) {
    const m = validarRefeicao(c, pedido.maxTime);
    if (m) validas.push(m);
  }
  if (validas.length < pedido.meals) {
    throw new ErroValidacao(
      `o modelo devolveu ${validas.length} receita(s) completa(s) de ${pedido.meals}`
    );
  }
  const ordenadas = validas.sort((a, b) => PESO_URGENCIA[a.urgencia] - PESO_URGENCIA[b.urgencia] || a.ordem - b.ordem).slice(0, pedido.meals).map((m, i) => ({ ...m, ordem: i + 1 }));
  const comprasCruas = Array.isArray(o?.compras) ? o.compras.map((c) => texto(c, 120)).filter(Boolean) : [];
  return {
    resumo: texto(o?.resumo, 400),
    refeicoes: ordenadas,
    compras: reconciliarCompras(ordenadas, pedido.inventory, pedido.pantry, comprasCruas)
  };
}
const ROTULOS = ["Prateleiras", "Gaveta aberta", "Porta"];
const TIPOS_ACEITOS = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const CORPO_MAXIMO = 10 * 1024 * 1024;
const REFEICOES_MAX = 7;
const TEMPOS_ACEITOS = [15, 30, 45];
function json(dados, status = 200, extras = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Resposta de API nunca entra em cache: despensa e cardapio mudam a
      // cada requisicao e uma copia velha seria pior que um erro.
      "cache-control": "no-store",
      ...extras
    }
  });
}
function erro(mensagem, status = 400) {
  return json({ error: mensagem }, status);
}
async function lerCorpo(req) {
  const tamanho = Number(req.headers.get("content-length") || 0);
  if (tamanho > CORPO_MAXIMO) throw new ErroValidacao("corpo grande demais");
  try {
    return await req.json();
  } catch {
    throw new ErroValidacao("corpo inválido");
  }
}
function validarImagens(bruto) {
  const lista = bruto?.images;
  if (!Array.isArray(lista) || lista.length !== 3) {
    throw new ErroValidacao(
      "Envie exatamente três fotos: prateleiras, gaveta aberta e porta."
    );
  }
  const saida = [];
  for (let i = 0; i < 3; i++) {
    const cru = lista[i];
    if (typeof cru !== "object" || cru === null) {
      throw new ErroValidacao("Não consegui abrir essa imagem. Tente fotografar novamente em JPG ou PNG.");
    }
    const o = cru;
    const mediaType = typeof o.mediaType === "string" ? o.mediaType : "";
    if (!TIPOS_ACEITOS.includes(mediaType)) {
      throw new ErroValidacao("Não consegui abrir essa imagem. Tente fotografar novamente em JPG ou PNG.");
    }
    const data = typeof o.data === "string" ? o.data : "";
    if (!data || data.startsWith("data:") || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) {
      throw new ErroValidacao("Não consegui abrir essa imagem. Tente fotografar novamente em JPG ou PNG.");
    }
    const rotulo = ROTULOS[i];
    const label = typeof o.label === "string" && ROTULOS.includes(o.label) ? o.label : rotulo;
    saida.push({ label, mediaType, data });
  }
  return saida;
}
async function rotaInventario(req, env) {
  const corpo = await lerCorpo(req);
  if (corpo?.demo === true) {
    return json({ items: inventarioDemo(), demo: true });
  }
  const imagens = validarImagens(corpo);
  if (!env.ANTHROPIC_API_KEY) {
    return json({ items: inventarioDemo(), demo: true });
  }
  const bruto = await chamarComFerramenta({
    apiKey: env.ANTHROPIC_API_KEY,
    modelo: env.ANTHROPIC_MODEL || MODELO_PADRAO,
    ferramenta: FERRAMENTA_INVENTARIO,
    maxTokens: 4096,
    conteudo: [
      { type: "text", text: PROMPT_INVENTARIO },
      ...blocosDeImagem(imagens),
      {
        type: "text",
        text: "As três fotos acima são da MESMA geladeira. Trate como um inventário único e consolide duplicatas."
      }
    ]
  });
  return json({ items: validarInventario(bruto), demo: false });
}
async function rotaCardapio(req, env) {
  const corpo = await lerCorpo(req);
  const meals = Math.min(REFEICOES_MAX, Math.max(1, Math.round(Number(corpo.meals) || 5)));
  const maxTimeCru = Math.round(Number(corpo.maxTime) || 30);
  const maxTime = TEMPOS_ACEITOS.includes(maxTimeCru) ? maxTimeCru : 30;
  const pantry = limparLista(corpo.pantry);
  const inventarioBruto = Array.isArray(corpo.inventory) ? corpo.inventory : [];
  const inventory = validarInventario({ items: inventarioBruto }).filter(
    (i) => i.status === "identificado"
  );
  if (corpo.demo === true || !env.ANTHROPIC_API_KEY) {
    const base = cardapioDemo(meals, maxTime);
    return json({
      ...base,
      compras: reconciliarCompras(base.refeicoes, inventarioDemo(), pantry, base.compras),
      demo: true
    });
  }
  if (inventory.length === 0) {
    return erro("Confirme pelo menos um alimento antes de montar o cardápio.");
  }
  const bruto = await chamarComFerramenta({
    apiKey: env.ANTHROPIC_API_KEY,
    modelo: env.ANTHROPIC_MODEL || MODELO_PADRAO,
    ferramenta: FERRAMENTA_CARDAPIO,
    maxTokens: 16384,
    conteudo: [
      {
        type: "text",
        text: promptCardapio(
          meals,
          maxTime,
          inventory.map(({ nome, categoria, quantidade_faixa }) => ({
            nome,
            categoria,
            quantidade_faixa
          })),
          pantry
        )
      }
    ]
  });
  try {
    const plano = validarCardapio(bruto, { meals, maxTime, inventory, pantry });
    return json({ ...plano, demo: false });
  } catch (e) {
    if (e instanceof ErroValidacao) {
      console.error("[cardapio rejeitado]", e.message);
      return erro("Não consegui montar o cardápio agora. Tente novamente.", 502);
    }
    throw e;
  }
}
async function rotaDespensaLer(req, env) {
  const deposito = abrirDespensa(env.DESPENSA);
  const id = lerId(req);
  if (!id) {
    const novo = novoId();
    return json(
      { items: DESPENSA_PADRAO, persisted: deposito.persistente },
      200,
      { "set-cookie": cabecalhoCookie(novo) }
    );
  }
  const guardado = await deposito.ler(id);
  return json({
    items: guardado ?? DESPENSA_PADRAO,
    persisted: deposito.persistente
  });
}
async function rotaDespensaGravar(req, env) {
  const corpo = await lerCorpo(req);
  const itens = limparLista(corpo.items);
  const deposito = abrirDespensa(env.DESPENSA);
  const existente = lerId(req);
  const id = existente ?? novoId();
  await deposito.gravar(id, itens);
  const extras = {};
  if (!existente) extras["set-cookie"] = cabecalhoCookie(id);
  return json(
    { items: itens, persisted: deposito.persistente },
    200,
    extras
  );
}
const index = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const rota = url.pathname;
    if (!rota.startsWith("/api/")) {
      if (env.ASSETS) {
        const resposta = await env.ASSETS.fetch(req);
        const tipo = resposta.headers.get("content-type") || "";
        if (!tipo.includes("text/html")) return resposta;
        const html = (await resposta.text()).replaceAll("__ORIGIN__", url.origin);
        return new Response(html, {
          status: resposta.status,
          headers: { ...Object.fromEntries(resposta.headers), "content-type": tipo }
        });
      }
      return new Response("Not found", { status: 404 });
    }
    try {
      if (rota === "/api/inventory" && req.method === "POST") return await rotaInventario(req, env);
      if (rota === "/api/menu" && req.method === "POST") return await rotaCardapio(req, env);
      if (rota === "/api/pantry" && req.method === "GET") return await rotaDespensaLer(req, env);
      if (rota === "/api/pantry" && req.method === "PUT") return await rotaDespensaGravar(req, env);
      return erro("rota não encontrada", 404);
    } catch (e) {
      if (e instanceof ErroValidacao) return erro(e.message, 400);
      if (e instanceof ErroAnthropic) {
        console.error("[anthropic]", e.message);
        return erro(
          rota === "/api/menu" ? "Não consegui montar o cardápio agora. Tente novamente." : "Não consegui ler as fotos agora. Tente novamente em alguns instantes.",
          502
        );
      }
      console.error("[erro]", e instanceof Error ? e.message : String(e));
      if (rota === "/api/pantry") return erro("Não foi possível salvar a despensa.", 500);
      return erro("Algo deu errado. Tente novamente.", 500);
    }
  }
};
const workerEntry = index ?? {};
export {
  workerEntry as default
};
//# sourceMappingURL=index.js.map
