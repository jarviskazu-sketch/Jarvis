# Módulo "receita" — a geladeira na ordem certa

Aba 🥬 RECEITA do Jarvis. Três fotos da geladeira viram um inventário que
você confirma, e só então um cardápio ordenado pelo que estraga primeiro.

## Onde o código mora

**Não aqui.** O código-fonte é o projeto `D:\8 - Claude - projeto\Receita`,
que também publica na Cloudflare. Neste repositório existem só duas coisas:

| arquivo | o que é |
|---|---|
| `receita-modulo.js` | a ponte entre a antena e o módulo — escrita à mão |
| `receita/` | o build, **gerado**. Não edite nada aqui dentro. |

Para atualizar depois de mexer no Receita:

```bash
npm run jarvis
```

Isso constrói e instala aqui. O `receita/` é versionado de propósito, para o
módulo funcionar num clone novo do Jarvis mesmo sem o projeto Receita no disco
— a mesma lógica da decisão do Radar.

## O que torna isso barato de manter

O Worker construído para a Cloudflare **não tem import externo nem API
exclusiva da plataforma**, então roda em Node sem alteração nenhuma. A antena
faz `import()` do mesmo `worker.mjs` que sobe na nuvem, e fornece o que a
Cloudflare fornecia: o KV vira um JSON em `agent-state/receita-despensa.json`.

É uma implementação só, em dois lugares. Reescrever a lógica em JS de servidor
daria duas versões para manter, e elas divergiriam na primeira correção feita
de um lado só.

## Rotas na antena

| rota | o que faz |
|---|---|
| `GET /receita/*` | a aplicação construída (estáticos, com fallback de SPA) |
| `/api/receita/*` | delegado ao worker; `/api/receita/menu` → `/api/menu` |

O prefixo `/api/receita` existe porque a antena já é dona de `/api`, e "menu"
é palavra boa demais para um painel do Jarvis não querer um dia. O valor é
injetado no `index.html` na hora da exportação.

## A chave da Anthropic é opcional

Sem `ANTHROPIC_API_KEY` no ambiente, o módulo roda inteiro em **modo
demonstração** e diz na tela que os resultados são exemplos — nunca finge que
leu fotos de verdade. Para ligar a análise real, defina a variável antes de
subir a antena.

## Três coisas que já deram errado aqui

**Caminho absoluto dos assets.** Na Cloudflare a aplicação é a raiz e
`/assets/index.js` funciona. Servida em `/receita/`, essa mesma URL bate na
raiz da antena e volta 404 — a página carregava creme e vazia. Por isso o
build do módulo usa `--base=/receita/`, e o script reconstrói no padrão logo
depois, para um `npm run deploy` não subir a versão errada para a nuvem.

**Prefixo duplicado.** Com a base `/api/receita` e as chamadas ainda em
`/api/pantry`, saía `/api/receita/api/pantry`. Os caminhos no cliente não
repetem o `/api`.

**Cookie de identidade.** Na nuvem cada navegador tem sua despensa, por
cookie. Aqui isso não funcionaria: o cookie é `Secure` e o navegador o
descarta em `http://127.0.0.1`, e o painel ainda roda dentro de um iframe.
Como a máquina é de uma pessoa só, a ponte injeta uma identidade fixa.
