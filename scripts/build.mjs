import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
// Bundle official SDK dependencies so installed plugins need no npm install.
await build({entryPoints:['mcp/server.mjs','mcp/channel-peers.mjs'], outdir:'dist', bundle:true,
  platform:'node', format:'esm', outExtension:{'.js':'.mjs'}, target:'node20', legalComments:'eof'});
await mkdir('dist/licenses', {recursive:true});
for (const [name, path] of Object.entries({
  'mcp-server':'node_modules/@modelcontextprotocol/server/LICENSE',
  'mcp-core':'node_modules/@modelcontextprotocol/core/LICENSE',
  zod:'node_modules/zod/LICENSE',
  'openai-codex':'mcp/vendor/LICENSE',
  'openai-NOTICE':'mcp/vendor/NOTICE',
})) await copyFile(path, `dist/licenses/${name}.txt`);

// Normalize whitespace in generated third-party output for clean Git patches.
for(const name of ['server','channel-peers'])
  await writeFile(`dist/${name}.mjs`, (await readFile(`dist/${name}.mjs`, "utf8")).replace(/[ \t]+$/gm, ""));
