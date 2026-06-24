# Tunnel OpenAI — setup local

Este arquivo resume como conectar este MVP ao OpenAI Secure MCP Tunnel.

## O que este projeto expõe

Servidor MCP local em Node.js via stdio, com tools para terminal, arquivos, processos e screenshot headless.

## Arquivos principais

- `tunnel-init.cmd`: gera o profile local do tunnel-client.
- `tunnel-doctor.cmd`: valida o profile do tunnel-client.
- `tunnel-run.cmd`: mantém o tunnel rodando para o ChatGPT usar.
- `run-mcp.cmd`: sobe o servidor MCP local diretamente.

## Ordem de uso

1. Instale as dependências:

```bat
install-deps.cmd
```

2. Gere o profile do tunnel:

```bat
tunnel-init.cmd
```

3. Informe o `tunnel_id` criado na OpenAI Platform.

4. Valide:

```bat
tunnel-doctor.cmd
```

5. Rode o tunnel:

```bat
tunnel-run.cmd
```

6. Deixe a janela aberta enquanto usa o conector no ChatGPT.

7. No ChatGPT Web, crie um Custom Connector/App usando conexão por Tunnel e informe o mesmo `tunnel_id`.

## Formato do profile gerado

O profile fica em:

```txt
%APPDATA%\tunnel-client\mcp-chatgpt-full-pc-dev.yaml
```

O comando MCP gerado usa caminhos curtos do Windows com `/`, porque o tunnel-client pode interpretar `\` como escape no YAML/comando.

Exemplo genérico:

```yaml
mcp:
  commands:
    - channel: main
      command: "C:/PROGRA~1/nodejs/node.exe C:/Users/User/DOCUME~1/MCPCHA~1/src/app.mjs"
```

## Nunca commitar

- API keys.
- Arquivos `.env`.
- `tunnel-client.exe`.
- `node_modules`.
- Logs e screenshots temporários.
