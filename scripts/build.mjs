import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: {
    'viero/cli': 'src/viero/cli.ts',
    'viero/mcp': 'src/viero/mcp.ts',
    'viero/indexer-server': 'src/viero/indexer/server.ts',
    'viero/signer-server': 'src/viero/execution/signerServer.ts',
  },
  outdir: 'build', bundle: true, platform: 'node', format: 'esm',
  target: 'node20', packages: 'external', sourcemap: true,
});
await copyFile('src/viero/storage/schema.sql', 'build/viero/schema.sql');
