# Fluxo do dukk-design (Open Design) — do pedido no chat ao resultado construído

> Documento de estudo: traça a jornada completa de uma requisição, do momento em que
> o usuário digita no chat até o artifact (HTML, deck, imagem...) renderizado de volta.

## Visão geral

O dukk-design é um sistema multi-camada:

- **Navegador (`apps/web`)** captura o pedido e renderiza o stream de resposta.
- **Daemon local (`apps/daemon`)** orquestra tudo, compõe o prompt e faz spawn de um
  **agente de IA real** (Claude Code por padrão) como subprocesso.
- **Conhecimento de design** é injetado via **skills + design-templates + design-systems + craft**.
- O resultado é um **artifact** gravado em disco e servido de volta ao chat.

```
┌─ NAVEGADOR (apps/web) ───────────────────────────────────────┐
│  ChatComposer → POST /api/runs → SSE /api/runs/:id/events     │
└──────────────────────────────────────────────────────────────┘
                          ↓ HTTP
┌─ DAEMON (apps/daemon) ───────────────────────────────────────┐
│  runs.create/stream → startChatRun()                          │
│    ├─ composeSystemPrompt() ← skill + design-system + craft   │
│    ├─ spawn(claude, args, {stdio, cwd, env})                  │
│    └─ stream parsing (claude-stream.ts) → SSE events          │
└──────────────────────────────────────────────────────────────┘
                          ↓ stdin/stdout
┌─ AGENTE IA (Claude Code subprocess) ─────────────────────────┐
│  lê preflight → template.html + tokens → gera <artifact>     │
└──────────────────────────────────────────────────────────────┘
                          ↓
              ARTIFACTS_DIR/<timestamp>-<slug>/index.html
```

---

## Passo a passo

### 1. Pedido no chat (frontend)

- O usuário digita no `ChatComposer.tsx` (input Lexical; suporta `@menção` de skills e
  attachments).
- Ao enviar, `sendComposedTurn()` monta o payload e `streamViaDaemon()`
  (`apps/web/src/providers/daemon.ts`, que se descreve como "SSE client for /api/runs")
  faz **`POST /api/runs`** com:
  - `message` (transcript completo), `currentPrompt`, `projectId`
  - `sessionMode` (`'design'` | `'code'`), `skillIds`, `attachments`, `model`, MCP/plugins
- Em seguida abre **`GET /api/runs/:id/events`** (Server-Sent Events) e consome o stream
  em `consumeDaemonRun()`.

| Função | Arquivo | Linhas |
|---|---|---|
| Input/Composer | `apps/web/src/components/ChatComposer.tsx` | 327, 1030-1060 |
| `streamViaDaemon` (POST /api/runs) | `apps/web/src/providers/daemon.ts` | 560-674 |
| `consumeDaemonRun` (SSE) | `apps/web/src/providers/daemon.ts` | 891-1150 |

### 2. Daemon recebe e orquestra

- O handler **`POST /api/runs`** (`apps/daemon/src/server.ts`) cria um *run* em memória
  (`design.runs.create`) e dispara `startChatRun()` de forma assíncrona via
  `design.runs.start()` (sem bloquear a resposta); o navegador então abre o SSE em
  `GET /api/runs/:id/events`.
- `startChatRun()` resolve o projeto (em `PROJECTS_DIR`) e o agente
  (`getAgentDef` → `runtimes/defs/claude.ts`).
- Existe também **`POST /api/chat`** (server.ts 11149), um caminho alternativo que
  abre a SSE *inline* na própria resposta e chama o mesmo `startChatRun()`; é usado por
  clientes não-web (MCP/SDK), não pelo `apps/web`.

| Função | Arquivo | Linhas |
|---|---|---|
| Handler `POST /api/runs` (usado pelo web) | `apps/daemon/src/server.ts` | 10247+ |
| Handler `POST /api/chat` (SSE inline; MCP/SDK) | `apps/daemon/src/server.ts` | 11149-11196 |
| `startChatRun()` (orquestração) | `apps/daemon/src/server.ts` | 7133-10075 |

### 3. Composição do prompt (o coração do design)

`composeSystemPrompt()` empilha ~17 camadas. As mais relevantes para design:

1. **Identity base** (designer) + **discovery/philosophy**.
2. **DESIGN.md** do design-system ativo (paleta, tipografia, tokens da marca) — fonte de
   verdade visual.
3. **SKILL.md** da skill/template ativo, com um **preflight** obrigatório: antes de gerar
   qualquer coisa, o agente *tem* que ler `assets/template.html`,
   `references/layouts.md`, `references/checklist.md`.
4. **Seções de craft** (typography, color, anti-ai-slop, a11y...) injetadas conforme
   `od.craft.requires` da skill.
5. Memory, instruções de projeto/usuário, contrato de mídia (se imagem/vídeo/áudio).

Tudo vira um **prompt monolítico** anexado ao bloco `# User request`.

| Função | Arquivo |
|---|---|
| `composeDaemonSystemPrompt()` | `apps/daemon/src/server.ts` (6569+) + `apps/daemon/src/prompts/system.ts` |
| `composeSystemPrompt()` (engine) | `packages/contracts/src/prompts/system.ts` (239-420) |
| `derivePreflight()` | `packages/contracts/src/prompts/system.ts` (818-837) |

### 4. Spawn do agente real

- `def.buildArgs()` monta os argumentos do Claude Code:
  `--input-format stream-json`, `--output-format stream-json`, `--model`,
  `--add-dir` (acesso a skills/design-systems), `--permission-mode bypassPermissions`.
- `spawn()` cria o subprocesso com `cwd` no projeto e env com `OD_DAEMON_URL`,
  `OD_TOOL_TOKEN` (token escopado para o agente chamar `/api/projects/*/files/*` de
  volta), `OD_PROJECT_ID`.
- O prompt é escrito no **stdin** como JSONL:
  - `stream-json` mantém o stdin **aberto** (permite input mid-turn).
  - `text` fecha o stdin imediatamente (one-shot).
- Skills ativas são copiadas (*staged*) para `<cwd>/.od-skills/<skill>/`;
  MCP servers vão para `.mcp.json`.

| Função | Arquivo | Linhas |
|---|---|---|
| Claude def (args, promptInputFormat) | `apps/daemon/src/runtimes/defs/claude.ts` | 16-98 |
| Child spawn | `apps/daemon/src/server.ts` | 8814-8956 |
| Escrita do prompt no stdin | `apps/daemon/src/server.ts` | 10043-10074 |

### 5. O agente constrói o resultado

Dentro do subprocesso, o Claude:

1. Lê o **preflight** → `template.html` (semente), `layouts.md`, `checklist.md`.
2. Faz *binding* dos tokens do design-system ativo no `:root`.
3. Gera o código validando contra o checklist + regras de craft.
4. Emite o resultado dentro de um marcador:

```html
<artifact identifier="social-media-dashboard" type="text/html" title="Social Media Dashboard">
<!doctype html>
<html>...</html>
</artifact>
```

### 6. Stream de volta → SSE

- O stdout do agente (JSONL) é parseado em tempo real por `claude-stream.ts`, que
  reconstrói `text_delta`, `thinking`, `tool_use`, `tool_result`, `usage` e detecta
  marcadores `<artifact>`.
- `send('agent', event)` emite cada evento como chunk SSE de volta ao navegador.

| Evento SSE | Handler frontend |
|---|---|
| `agent` (text_delta, tool_use, artifact...) | `onAgentEvent()` |
| `start` / `end` / `error` | status do run |

| Função | Arquivo | Linhas |
|---|---|---|
| Claude stream parsing | `apps/daemon/src/claude-stream.ts` | 48-600+ |
| JSON event stream (Gemini/Codex/OpenCode) | `apps/daemon/src/json-event-stream.ts` | 150+ |
| Emissão SSE `send()` | `apps/daemon/src/server.ts` | 7785-7800 |

### 7. Persistência do artifact

- Ao salvar, **`POST /api/artifacts/save`** gera
  `ARTIFACTS_DIR/<timestamp>-<slug>/index.html`.
- Roda o **lint anti-ai-slop** (`lint-artifact.ts`, violações P0/P1).
- Serve em `/artifacts/<timestamp>-<slug>/index.html`.

| Item | Arquivo / valor |
|---|---|
| Handler save | `apps/daemon/src/project-routes.ts` (1895-1935) |
| `ARTIFACTS_DIR` | `path.join(RUNTIME_DATA_DIR, 'artifacts')` (`server.ts` 1475) |
| Static serve | `app.use('/artifacts', express.static(ARTIFACTS_DIR))` (`server.ts` 5918) |
| Lint | `apps/daemon/src/lint-artifact.ts` |

### 8. Renderização no chat

- `AssistantMessage.tsx` renderiza os blocos: texto (`ProseBlock`), thinking colapsável,
  tool-groups (`ToolGroupCard`), status (`StatusPill`).
- `ChatArtifactPreview` (`ChatPane.tsx`) mostra o resultado:
  `<iframe>` para HTML, `<img>` para imagem, `<video>`, `SketchPreview`, mais ações
  de Share/Download.
- Se o agente precisar de esclarecimento, emite `<question-form>` que renderiza na aba
  Questions; a resposta volta como a próxima mensagem do usuário.

| Função | Arquivo | Linhas |
|---|---|---|
| Render dos blocos | `apps/web/src/components/AssistantMessage.tsx` | 385-694 |
| Preview de artifact | `apps/web/src/components/ChatPane.tsx` | 355-387 |
| Question form | `apps/web/src/artifacts/question-form.ts` | — |

---

## As 4 camadas de conhecimento de design

| Camada | Localização | Responsabilidade |
|---|---|---|
| **Skills (funcionais)** | `skills/` | Utilities, design-system tools; trabalho logic-driven invocado mid-task |
| **Templates (renderização)** | `design-templates/` | Formas de artifact (deck, prototype, image/video/audio) |
| **Design Systems** | `design-systems/` | Paleta, tipografia, tokens da marca (`DESIGN.md`) |
| **Craft (universal)** | `craft/` | Regras brand-agnostic (hierarquia tipográfica, a11y, anti-slop) |

**Conceito-chave:**

> **Skills** são invocadas pelo agente *durante* a tarefa.
> **Design-templates, design-systems e craft** são *contexto injetado* no system prompt.
> O agente lê a semente do template, faz binding dos tokens da marca, segue layouts de
> referência e valida contra checklist + lint — tudo *antes e durante* a geração do
> código final.

---

## Fluxo resumido (one-liner por etapa)

```
1. ChatComposer.onSend → streamViaDaemon → POST /api/runs
2. design.runs.create + stream (SSE) → startChatRun() async
3. composeSystemPrompt() ← DESIGN.md + SKILL.md + craft + memory
4. def.buildArgs() → spawn(claude, {cwd, env}) → prompt via stdin
5. agente lê preflight → template + tokens → emite <artifact>
6. claude-stream.ts parseia JSONL → send('agent', ...) → SSE
7. POST /api/artifacts/save → lint → ARTIFACTS_DIR/<ts>-<slug>/index.html
8. AssistantMessage + ChatArtifactPreview renderizam no chat
```
