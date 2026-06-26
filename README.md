# MCP ChatGPT Full PC Dev

Servidor MCP local para Windows que expoe ferramentas de terminal, arquivos,
processos, browser headless/interativo e helpers de Salesforce LWC para uso via
OpenAI Secure MCP Tunnel.

O projeto roda localmente em Node.js por stdio. O `tunnel-client.exe` conecta
esse servidor local a um Custom Connector/App no ChatGPT.

## Visao Geral

Fluxo de execucao:

```txt
ChatGPT / Custom Connector
-> OpenAI Secure MCP Tunnel
-> tunnel-client.exe no Windows
-> Node.js executando src/app.mjs via stdio
-> ferramentas MCP locais
```

Principais capacidades:

- Executar comandos PowerShell sincronamente ou em background.
- Ler, criar, mover, buscar e remover arquivos/pastas.
- Tirar screenshot headless de URL direta.
- Controlar uma sessao Playwright persistente para browser.
- Descobrir servidores HTTP locais.
- Rodar e capturar Salesforce LWC Local Dev Preview.

## Estrutura

```txt
MCP ChatGPT
|-- config/settings.json
|-- src/app.mjs
|-- src/core/
|-- src/tools/
|-- install-deps.cmd
|-- doctor.cmd
|-- run-mcp.cmd
|-- tunnel-init.cmd
|-- tunnel-doctor.cmd
|-- tunnel-run.cmd
|-- tunnel-client.exe
|-- package.json
|-- README.md
`-- TUNNEL_SETUP.md
```

## Requisitos

Antes de instalar, tenha:

- Windows.
- Node.js LTS instalado em `C:\Program Files\nodejs`.
- `npm` disponivel no PATH.
- Conta OpenAI com acesso a Tunnels e Custom Connectors/Apps em modo
  desenvolvedor.
- Um tunnel criado na OpenAI Platform.
- Runtime API Key/API Key de projeto para o tunnel.
- `tunnel-client.exe` compativel com Windows.

Observacao sobre Node.js: os scripts deste projeto procuram o Node em
`C:\Program Files\nodejs\node.exe`. Instalacoes via nvm, fnm, Volta, Scoop ou
outro caminho podem funcionar, mas exigem ajuste manual no `tunnel-init.cmd` ou
no YAML gerado.

## Instalacao em Ordem Cronologica

### 1. Obter o projeto

Descompacte ou clone o projeto em uma pasta local. Caminho recomendado:

```txt
C:\Users\SEU_USUARIO\Documents\MCP ChatGPT
```

O caminho pode ter espacos. Os scripts de tunnel usam caminho curto 8.3 do
Windows para evitar problema de escape no YAML.

### 2. Instalar dependencias

Abra CMD na pasta do projeto:

```bat
cd /d "C:\Users\SEU_USUARIO\Documents\MCP ChatGPT"
install-deps.cmd
```

Esse script executa:

```bat
npm install
npx playwright install chromium
```

### 3. Validar o servidor MCP local

Ainda no CMD:

```bat
doctor.cmd
```

Resultado esperado: JSON com `ok: true`, `rootDir`, `profileName` e
configuracao carregada.

### 4. Baixar o tunnel-client

Baixe o binario Windows do OpenAI tunnel-client e coloque na raiz do projeto:

```txt
C:\Users\SEU_USUARIO\Documents\MCP ChatGPT\tunnel-client.exe
```

Fontes recomendadas:

- Pagina de Tunnels na OpenAI Platform, quando ela oferecer o link de download
  do cliente.
- Release publico mais recente do repositorio oficial:
  `https://github.com/openai/tunnel-client/releases`

No release publico, baixe o ZIP de Windows apropriado:

```txt
windows-amd64.zip
```

Em maquinas ARM, use:

```txt
windows-arm64.zip
```

Extraia o ZIP e copie/renomeie o executavel para:

```txt
tunnel-client.exe
```

### 5. Criar um tunnel na OpenAI Platform

Acesse a pagina de Tunnels da OpenAI Platform e crie um tunnel.

Copie o ID gerado, no formato:

```txt
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 6. Gerar o profile local do tunnel

Rode:

```bat
tunnel-init.cmd
```

Quando o script pedir, informe o `tunnel_id`.

O profile sera criado em:

```txt
%APPDATA%\tunnel-client\mcp-chatgpt-full-pc-dev.yaml
```

O YAML gerado aponta para o MCP local usando caminhos curtos e barras `/`.
Exemplo do formato:

```yaml
mcp:
  commands:
    - channel: main
      command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```

### 7. Obter a Runtime API Key

Crie ou copie uma API key ativa da OpenAI Platform.

A key sera informada no terminal quando `tunnel-doctor.cmd` ou
`tunnel-run.cmd` pedirem. Ela nao deve ser salva no YAML, no Git, em print ou
em documentacao publica.

### 8. Validar o tunnel

Rode:

```bat
tunnel-doctor.cmd
```

Cole a API key quando solicitado.

Resultado esperado:

```txt
RESULT ok
NEXT tunnel-client run --profile mcp-chatgpt-full-pc-dev
```

Alguns `SKIP` podem ser normais quando o servidor MCP usa stdio.

### 9. Rodar o tunnel

Rode:

```bat
tunnel-run.cmd
```

Cole a API key quando solicitado.

Deixe essa janela aberta enquanto o conector estiver em uso.

Resultado esperado no log:

```txt
tunnel-client started
```

### 10. Criar o Custom Connector/App no ChatGPT

No ChatGPT Web, abra as configuracoes da conta:

```txt
Perfil/conta no canto inferior esquerdo
-> Configuracoes
-> Aplicativos
```

Em `Aplicativos`, abra `Configuracoes avancadas` e habilite:

```txt
Modo desenvolvedor
```

Depois que o modo desenvolvedor estiver habilitado, o botao `Criar aplicativo`
aparece na tela de aplicativos.

Crie um novo app/conector com os campos:

Valores esperados:

```txt
Nome: escolha um nome, por exemplo PC Controller
Connection/Conexao: Tunnel
Tunnel ID: mesmo tunnel_xxx usado no tunnel-init.cmd
Authentication/Autenticacao: sem autenticacao adicional
```

Na criacao, a interface tambem pode mostrar:

```txt
Tuneis disponiveis: selecione o tunnel criado na OpenAI Platform
ou use "Usar ID do tunel" e cole o tunnel_xxx manualmente.
```

Se a interface exibir o aviso de risco para servidores MCP personalizados,
marque a confirmacao apenas se o PC, o tunnel e o projeto forem confiaveis.

Clique em `Criar`.

Depois de criar, o ChatGPT faz o scan das ferramentas MCP disponiveis.

O app criado aparece na lista de `Aplicativos habilitados` com uma tag `DEV`.
Ao abrir esse app na lista, a tela mostra informacoes como tunnel conectado,
permissoes, autorizacao e botao para atualizar/desconectar.

Para evitar pedidos repetidos de aprovacao a cada chamada de ferramenta, abra o
app criado na lista de `Aplicativos habilitados` e ajuste:

```txt
Permissoes: Permitir tudo
```

Essa opcao aparece com aviso de `RISCO ELEVADO`. Use apenas quando o PC, o
tunnel, o projeto local e o app forem confiaveis.

Depois de criado, o app pode ser usado nos chats pelo menu de apps ou chamando
o nome do app no campo de mensagem.

### 11. Teste inicial

Com `tunnel-run.cmd` aberto, faca uma chamada simples pelo conector:

```txt
Listar a pasta C:\Users\SEU_USUARIO\Documents\MCP ChatGPT
```

Ou:

```txt
Ler o arquivo C:\Users\SEU_USUARIO\Documents\MCP ChatGPT\README.md
```

Se a listagem/leitura funcionar, o tunnel e o servidor MCP estao operacionais.

## Ferramentas Expostas

### Terminal e processos

- `ps`
- `start_ps`
- `read_process`
- `stop_process`
- `list_processes`

### Arquivos e pastas

- `list_directory`
- `get_file_info`
- `create_directory`
- `read_file`
- `write_file`
- `append_file`
- `delete_path`
- `move_path`
- `search_names`

### Browser e screenshots

- `screenshot_url`
- `browser_start`
- `browser_attach`
- `browser_list_sessions`
- `browser_list_pages`
- `browser_open_url`
- `browser_current_url`
- `browser_screenshot`
- `browser_capture_candidate`
- `browser_console`
- `browser_resize`
- `browser_close`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_press`
- `browser_hover`
- `browser_wait`
- `browser_eval`

### HTTP local

- `local_http_probe`

### Salesforce LWC Local Dev

- `lwc_preview_start`
- `lwc_preview_list`
- `lwc_preview_stop`
- `lwc_preview_capture`

## Salesforce LWC Local Dev Opcional

As ferramentas `lwc_preview_*` sao opcionais. Elas nao sao necessarias para o
MCP basico de terminal, arquivos e browser funcionar.

Para usar as ferramentas de LWC em um PC novo, alem dos requisitos principais,
instale/configure:

- Salesforce CLI `sf`.
- Comando/plugin que disponibiliza `sf lightning dev component`.
- Uma org autenticada localmente, por exemplo via `sf org login web`.
- Um projeto Salesforce DX local, com `sfdx-project.json`.
- O componente LWC dentro de `force-app/main/default/lwc/<nomeDoComponente>`.

Validacoes uteis:

```bat
sf --version
sf plugins --core
sf org list
sf lightning dev component --help
```

Se `sf lightning dev component --help` nao existir, instale/atualize os plugins
Salesforce necessarios antes de usar `lwc_preview_capture`.

## Configuracao

Arquivo principal:

```txt
config/settings.json
```

Campos importantes:

```json
{
  "profileName": "mcp-chatgpt-full-pc-dev",
  "securityMode": "denylist",
  "allowedRoots": [],
  "maxCommandTimeoutMs": 300000,
  "defaultCommandTimeoutMs": 60000
}
```

Quando `allowedRoots` esta vazio, o servidor MCP nao restringe caminhos por
conta propria. Para limitar o acesso a pastas especificas, preencha:

```json
"allowedRoots": [
  "C:\\Users\\SEU_USUARIO\\Documents",
  "C:\\Users\\SEU_USUARIO\\Desktop",
  "C:\\Users\\SEU_USUARIO\\Downloads"
]
```

`securityMode: "denylist"` mantem bloqueios basicos contra comandos perigosos.

## Scripts

### `install-deps.cmd`

Instala dependencias Node e o Chromium usado pelo Playwright.

### `doctor.cmd`

Executa `node src/app.mjs --doctor` para validar se o servidor local carrega.

### `run-mcp.cmd`

Roda o servidor MCP local diretamente via stdio.

### `tunnel-init.cmd`

Cria o profile YAML do tunnel em `%APPDATA%\tunnel-client`.

### `tunnel-doctor.cmd`

Valida o profile do tunnel usando a API key informada no terminal.

### `tunnel-run.cmd`

Inicia o `tunnel-client` e mantem a ponte ativa para o ChatGPT.

## Documentos Auxiliares

`README.md` e a fonte principal para instalacao em ordem cronologica.

`TUNNEL_SETUP.md` e um resumo curto focado somente no tunnel. Ele pode ser usado
como referencia rapida, mas nao substitui os passos completos deste README.

## Troubleshooting

### `write |1: file already closed`

O processo local do MCP fechou durante a inicializacao.

Possiveis causas:

- Node.js nao encontrado.
- Caminho do `src/app.mjs` incorreto.
- Profile YAML apontando para caminho quebrado.
- Aspas ou barras interpretadas incorretamente pelo tunnel-client.

Valide primeiro:

```bat
doctor.cmd
```

Depois confira o profile:

```txt
%APPDATA%\tunnel-client\mcp-chatgpt-full-pc-dev.yaml
```

### `fork/exec C:PROGRA~1nodejsnode.exe`

O comando do YAML provavelmente usou barras invertidas `\` e elas foram
interpretadas como escape.

Use barras `/`:

```yaml
command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```

### Nenhuma ferramenta aparece no ChatGPT

Verifique:

1. `tunnel-run.cmd` esta aberto.
2. O log mostra `tunnel-client started`.
3. O `tunnel_id` do Custom Connector/App e o do profile YAML sao iguais.
4. `doctor.cmd` retorna `ok: true`.

### Porta 8080 em uso

O profile do tunnel usa por padrao:

```yaml
health:
  listen_addr: "127.0.0.1:8080"
```

Se a porta estiver ocupada, altere `listen_addr` no YAML ou encerre o processo
que esta usando a porta.

## Distribuicao por ZIP

Para distribuir em ZIP, normalmente inclua:

```txt
config/
src/
*.cmd
package.json
package-lock.json
README.md
TUNNEL_SETUP.md
```

Normalmente nao inclua:

```txt
node_modules/
logs/
screenshots/
tmp/
.env
chaves de API
tunnel-client.exe, se o destino for baixar o binario separadamente
```

Na maquina de destino, siga a instalacao desde o passo 1.

## Checklist Rapido

```txt
1. Instalar Node.js LTS.
2. Copiar/descompactar o projeto.
3. Rodar install-deps.cmd.
4. Copiar tunnel-client.exe para a raiz do projeto.
5. Criar tunnel na OpenAI Platform.
6. Rodar tunnel-init.cmd e informar tunnel_id.
7. Rodar tunnel-doctor.cmd e informar API key.
8. Rodar tunnel-run.cmd e deixar aberto.
9. Criar Custom Connector/App no ChatGPT com o tunnel_id.
10. Testar list_directory ou read_file.
```

## Seguranca

- Nao salve API keys no repositorio.
- Nao publique logs ou screenshots que possam conter dados sensiveis.
- Revise `allowedRoots` antes de usar em ambiente compartilhado.
- Mantenha `securityMode` em `denylist` ou configure uma politica mais restrita.
- Revise comandos antes de expor o conector para terceiros.
