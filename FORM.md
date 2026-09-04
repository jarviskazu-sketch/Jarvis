# Módulo "form" — coach de execução de exercícios

Aba 🏋 FORM do Jarvis. Envie um vídeo curto de um exercício e veja cada
repetição analisada; ou monte a rotina da semana; ou consulte a biblioteca de
23 exercícios.

## Onde o código mora

**Não aqui.** O código-fonte é o projeto `D:\8 - Claude - projeto\Form`.
Neste repositório existem só:

| arquivo | o que é |
|---|---|
| `form-modulo.js` | a ponte com a antena — escrita à mão |
| `form/` | o build, **gerado**. Não edite nada aqui dentro. |

Para atualizar depois de mexer no Form:

```bash
npm run jarvis
```

## O que este módulo NÃO tem, de propósito

**Nenhuma rota de API.** Diferente do receita, aqui a antena só serve
arquivos. Não há Worker, não há armazenamento no servidor, não há chamada de
rede com o vídeo. O produto inteiro roda no navegador: a leitura de pose pelo
MediaPipe, o planejador determinístico e o catálogo embutido.

Isso é a promessa de privacidade do produto, não um detalhe de
implementação — **se um dia aparecer uma rota `/api/form` aqui, é sinal de
que alguém a quebrou.**

## Rotas na antena

| rota | o que faz |
|---|---|
| `GET /form/*` | a aplicação construída, com fallback de SPA |

## O servidor de arquivos é compartilhado

`modulo-estatico.js` serve tanto o form quanto o receita. Foi extraído por um
motivo específico: a trava contra travessia de caminho é código de segurança,
e duplicada em cada módulo uma correção futura seria lembrada só numa das
cópias. Testado com 14 tentativas de escape (`../`, `..%2f`, `....//`,
`%2e%2e`, barra invertida, caminho por dentro de `assets/`) nos dois módulos.

## Uma dependência de rede que vale saber

O modelo de pose (~8 MB entre wasm e `pose_landmarker_lite`) é baixado de CDN
na primeira análise. Sem internet naquele momento, a análise de vídeo não
roda — a biblioteca e o planejador continuam funcionando normalmente.
