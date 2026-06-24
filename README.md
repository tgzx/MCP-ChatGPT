# MCP ChatGPT Full PC Dev

MVP de servidor MCP local para permitir que o ChatGPT use um computador Windows por meio do OpenAI Secure MCP Tunnel.

Este projeto nasceu para funcionar como um "PC Controller" simples: o ChatGPT descobre ferramentas MCP, chama essas ferramentas pelo tunnel e o servidor local executa ações no PC autorizado.

## Status atual

Validado em Windows com OpenAI Tunnel.

Fluxo comprovado:

```txt
ChatGPT
→ Custom Connector / App em modo desenvolvedor
→ OpenAI Secure MCP Tunnel
→ tunnel-client.exe rodando no PC
→ servidor MCP local em Node.js via stdio
→ ferramentas como list_directory, read_file e ps
```

Teste real validado: o ChatGPT conseguiu listar a pasta do projeto usando a ferramenta `list_directory`.

## Ferramentas disponíveis

- `ps`: executa comando PowerShell.
- `start_ps`: inicia comando PowerShell longo em segundo plano.
- `read_process`: lê stdout/stderr de processo iniciado por `start_ps`.
- `stop_process`: encerra processo iniciado por `start_ps`.
- `list_processes`: lista processos criados por `start_ps`.
- `list_directory`: lista arquivos e pastas.
- `get_file_info`: mostra metadados de arquivo ou pasta.
- `create_directory`: cria pasta recursivamente.
- `read_file`: lê arquivo de texto.
- `write_file`: cria ou sobrescreve arquivo de texto.
- `append_file`: adiciona texto ao final de arquivo.
- `delete_path`: remove arquivo ou pasta, recusando raiz de unidade.
- `move_path`: move ou renomeia arquivo ou pasta.
- `search_names`: busca arquivos/pastas por nome.
- `screenshot_url`: abre URL em Edge headless, com fallback Chromium, e retorna screenshot.

## Estrutura principal

```txt
MCP ChatGPT
├─ config/settings.json
├─ src/app.mjs
├─ src/core
├─ src/tools
├─ install-deps.cmd
├─ doctor.cmd
├─ run-mcp.cmd
├─ tunnel-init.cmd
├─ tunnel-doctor.cmd
├─ tunnel-run.cmd
├─ tunnel-client.exe
├─ README.md
└─ TUNNEL_SETUP.md
```

## Requisitos em uma nova máquina

- Windows.
- Node.js LTS instalado.
- Conta OpenAI com acesso a Tunnels e Custom Connectors / Apps em modo desenvolvedor.
- Um tunnel criado na OpenAI Platform.
- Uma Runtime API Key / API Key de projeto válida.
- `tunnel-client.exe` baixado do release oficial do `openai/tunnel-client`.
## Instalação a partir de ZIP em outro computador

### 1. Descompactar o projeto

Recomendado descompactar em:

```txt
C:\Users\SEU_USUARIO\Documents\MCP ChatGPT
```

O nome da pasta pode ter espaço, mas isso exige cuidado na configuração do tunnel. Este README já documenta o workaround que funcionou.

### 2. Instalar dependências

Abra CMD na pasta do projeto:

```bat
cd /d "C:\Users\SEU_USUARIO\Documents\MCP ChatGPT"
install-deps.cmd
```

Esse script roda:

```bat
npm install
npx playwright install chromium
```

### 3. Validar o servidor local

```bat
doctor.cmd
```

Resultado esperado: JSON com `ok: true` e a lista de ferramentas.
### 4. Baixar o tunnel-client

Na página de releases do projeto `openai/tunnel-client`, baixe o binário compatível com Windows.

Opção recomendada:

```txt
windows-amd64.zip
```

Se baixar o pacote `all`, o executável costuma ficar em:

```txt
bin\windows_amd64\tunnel-client.exe
```

Copie o executável para a raiz do projeto:

```txt
C:\Users\SEU_USUARIO\Documents\MCP ChatGPT\tunnel-client.exe
```

### 5. Criar um tunnel na OpenAI Platform

Acesse:

```txt
https://platform.openai.com/settings/organization/tunnels
```

Crie um tunnel e copie o ID, por exemplo:

```txt
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
### 6. Gerar o profile local do tunnel

Rode:

```bat
tunnel-init.cmd
```

Informe o `tunnel_id` quando solicitado.

Esse script gera o arquivo:

```txt
%APPDATA%\tunnel-client\mcp-chatgpt-full-pc-dev.yaml
```

O profile aponta para o servidor MCP local usando caminhos curtos do Windows e barras `/`, evitando bugs de escape em YAML/comando.

Formato esperado do comando no YAML:

```yaml
mcp:
  commands:
    - channel: main
      command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```

Atenção: o caminho exato muda conforme usuário, idioma do Windows e local da pasta.
### 7. Obter Runtime API Key

Acesse:

```txt
https://platform.openai.com/settings/organization/api-keys
```

Crie ou use uma API key ativa. No terminal ela será usada como variável de ambiente `CONTROL_PLANE_API_KEY`.

Não cole essa chave em chat, README, print público ou commit.

### 8. Validar o tunnel

Rode:

```bat
tunnel-doctor.cmd
```

Cole a API key quando o terminal pedir.

Resultado esperado:

```txt
RESULT ok
NEXT tunnel-client run --profile mcp-chatgpt-full-pc-dev
```

Alguns `SKIP` são normais para MCP via stdio:

```txt
mcp_server_reachable SKIP
oauth_metadata SKIP
codex_plugin SKIP
```
### 9. Rodar o tunnel

Rode:

```bat
tunnel-run.cmd
```

Cole a API key quando pedir.

A janela precisa ficar aberta enquanto o ChatGPT usa o conector.

Resultado esperado no log:

```txt
🟢 tunnel-client started
```

### 10. Criar o app/conector no ChatGPT

No ChatGPT Web:

```txt
Settings
→ Aplicativos / Connectors
→ Criar aplicativo / Custom connector
→ Conexão: Túnel
→ Informar o tunnel_id
→ Sem autenticação
→ Marcar ciência do risco
→ Criar
```

Se tudo estiver certo, o ChatGPT vai fazer scan das ferramentas e exibir as actions.
## Teste inicial pelo ChatGPT

Com `tunnel-run.cmd` aberto, peça no chat:

```txt
Use o PC Controller para listar a pasta C:\Users\SEU_USUARIO\Documents\MCP ChatGPT.
```

Ou:

```txt
Use o PC Controller e leia o arquivo C:\Users\SEU_USUARIO\Documents\MCP ChatGPT\checklist.txt.
```

Se a resposta listar arquivos da máquina, o tunnel está funcional.

## Pegadinha crítica que quebrou o MVP

No Windows, comandos com `\` dentro do YAML causaram problema no `tunnel-client`.

O log ruim mostrava algo parecido com:

```txt
fork/exec C:PROGRA~1nodejsnode.exe: The system cannot find the file specified
```

Ou seja, o `tunnel-client` removeu as barras invertidas.
A solução validada foi:

- Usar caminho curto 8.3 do Windows.
- Trocar `\` por `/`.
- Chamar `node.exe` direto, sem `cmd.exe /c` e sem `.cmd` no campo `command`.

Comando final funcional neste PC:

```yaml
command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```

Para descobrir caminhos curtos manualmente:

```bat
for %I in ("C:\Program Files\nodejs\node.exe") do @echo %~sI
for %I in ("C:\Users\SEU_USUARIO\Documents\MCP ChatGPT\src\app.mjs") do @echo %~sI
```

Depois substitua `\` por `/` no YAML.
## Segurança

Este MVP pode ser poderoso demais se deixado totalmente aberto.

Arquivo de configuração do servidor MCP:

```txt
config/settings.json
```

Campo importante:

```json
"allowedRoots": []
```

Quando `allowedRoots` está vazio, o MCP não limita pastas por conta própria.

Recomendação para uso real:

```json
"allowedRoots": [
  "C:\\Users\\SEU_USUARIO\\Documents",
  "C:\\Users\\SEU_USUARIO\\Desktop",
  "C:\\Users\\SEU_USUARIO\\Downloads"
]
```

Também é prudente manter `securityMode` como:

```json
"securityMode": "denylist"
```
## Scripts do projeto

### `install-deps.cmd`

Instala dependências Node e navegador Chromium do Playwright.

### `doctor.cmd`

Valida o servidor MCP local sem tunnel.

### `run-mcp.cmd`

Sobe o servidor MCP local via stdio. Normalmente não é chamado direto pelo usuário final.

### `tunnel-init.cmd`

Gera o profile YAML do tunnel em `%APPDATA%\tunnel-client`.

### `tunnel-doctor.cmd`

Valida o profile do tunnel usando a API key informada no terminal.

### `tunnel-run.cmd`

Sobe o `tunnel-client` e mantém a ponte ativa para o ChatGPT.
## Troubleshooting

### Erro: `write |1: file already closed`

Significa que o ChatGPT tentou inicializar o MCP, mas o processo local já tinha fechado.

Causas comuns:

- Caminho do comando MCP quebrado.
- Aspas mal interpretadas.
- Barra invertida removida pelo YAML/comando.
- Node.js não encontrado.
- `src/app.mjs` não encontrado.

Verifique o YAML:

```txt
%APPDATA%\tunnel-client\mcp-chatgpt-full-pc-dev.yaml
```

### Erro: `fork/exec C:PROGRA~1nodejsnode.exe`

O comando está usando `\` e o tunnel-client removeu as barras.

Corrija para `/`:

```yaml
command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```
### Conector criado, mas nenhuma ferramenta aparece

Confira se `tunnel-run.cmd` está aberto e se o log mostra:

```txt
🟢 tunnel-client started
```

Depois confira se o app local responde:

```bat
doctor.cmd
```

### Porta 8080 em uso

O profile usa:

```yaml
health:
  listen_addr: "127.0.0.1:8080"
```

Se a porta estiver ocupada, troque para outra porta livre ou encerre o processo antigo do tunnel.

### API key

A key é usada apenas no terminal como `CONTROL_PLANE_API_KEY`.

Não grave a key no YAML, no README ou no Git.
## Publicação / ZIP do MVP

Antes de zipar para outra máquina, recomenda-se não incluir:

```txt
node_modules
logs
screenshots temporários
chaves de API
```

O destinatário deve rodar:

```bat
install-deps.cmd
tunnel-init.cmd
tunnel-doctor.cmd
tunnel-run.cmd
```

## Checklist rápido em outra máquina

```txt
1. Instalar Node.js LTS.
2. Descompactar o projeto.
3. Copiar tunnel-client.exe para a raiz.
4. Rodar install-deps.cmd.
5. Criar tunnel na OpenAI Platform.
6. Rodar tunnel-init.cmd e informar tunnel_id.
7. Rodar tunnel-doctor.cmd e informar API key.
8. Rodar tunnel-run.cmd e deixar aberto.
9. Criar Custom Connector no ChatGPT usando Tunnel.
10. Testar list_directory/read_file.
```

## Estado validado neste PC

- Profile: `mcp-chatgpt-full-pc-dev`.
- Tunnel ID: `tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
- Connector/App: `PC Controller`.
- Status: conectado em modo desenvolvedor.
- Ferramentas descobertas pelo ChatGPT: sim.
- Teste real: `list_directory` funcionou.

## Dependências e pré-requisitos detalhados

### Dependências externas obrigatórias

Estas dependências precisam existir na máquina antes do MVP funcionar:

- Windows.
- Node.js LTS, incluindo `node` e `npm` no PATH.
- OpenAI `tunnel-client.exe` compatível com Windows.
- Conta/OpenAI workspace com acesso a Tunnels e Custom Connectors / Apps em modo desenvolvedor.
- Tunnel criado na OpenAI Platform.
- API key ativa para ser usada como `CONTROL_PLANE_API_KEY`.

### Dependências Node do projeto

Declaradas em `package.json`:

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "latest",
  "playwright": "latest",
  "zod": "^3.25.76"
}
```
Descrição rápida:

- `@modelcontextprotocol/sdk`: SDK usado para criar o servidor MCP e expor as ferramentas.
- `zod`: valida os schemas de entrada das tools MCP.
- `playwright`: usado pela ferramenta `screenshot_url` para abrir páginas em navegador headless.

### Dependência de navegador headless

Além do pacote `playwright`, o projeto precisa instalar o navegador Chromium usado como fallback:

```bat
npx playwright install chromium
```

O script `install-deps.cmd` já executa isso.

### O que o `install-deps.cmd` instala

```bat
npm install
npx playwright install chromium
```

Ou seja, ele instala:

- `node_modules` com `@modelcontextprotocol/sdk`, `playwright` e `zod`.
- navegador Chromium do Playwright.
### O que o ZIP não precisa levar

Para distribuir o MVP em ZIP, normalmente não é necessário incluir:

```txt
node_modules
package-lock.json, se quiser reinstalação limpa
logs
screenshots temporários
chaves de API
```

Ao abrir em outra máquina, rode `install-deps.cmd` para reconstruir as dependências.

### Verificação rápida das dependências

```bat
node -v
npm -v
npm list @modelcontextprotocol/sdk playwright zod
```

E para validar sintaxe do servidor:

```bat
npm run check
```
