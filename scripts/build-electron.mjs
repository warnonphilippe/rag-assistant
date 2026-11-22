// Compile le processus principal (ESM) et le script de préchargement (CommonJS, requis par le bac à sable).
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.mjs', format: 'esm', packages: 'external' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', format: 'cjs', external: ['electron'] });
// Point d'entrée du moteur seul, pour les tests avec les vrais modèles sous Node.
await build({ ...common, entryPoints: ['electron/core/index.ts'], outfile: 'dist-electron/core.mjs', format: 'esm', packages: 'external' });
