import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';

loadDotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
});

const config = loadConfig();
const createMcp = () => {
  const server = new McpServer({
    name: 'visual-diagram-gen',
    version: '0.1.0',
  });
  registerTools(server, config.API_BASE_URL, config.MCP_API_TOKEN);
  return server;
};
if (config.MCP_TRANSPORT === 'stdio') {
  const server = createMcp();
  await server.connect(new StdioServerTransport());
} else {
  const http = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${config.MCP_API_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'MCP authentication required',
            details: [],
          },
        }),
      );
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcp();
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  http.listen(3002, '0.0.0.0');
}
