// Télécharge les modèles locaux dans le dossier de données de l'application (réutilisés ensuite par l'app).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalModels } from '../../dist-electron/core.mjs';

export const modelsDir = process.env.RAG_MODELS_DIR ?? join(homedir(), 'Library', 'Application Support', 'Assistant RAG', 'models');
if (import.meta.url === `file://${process.argv[1]}`) {
  let last = '';
  const models = new LocalModels(modelsDir, () => {
    const line = models.list().map((m) => `${m.id}:${m.installed ? 'ok' : Math.round(m.progress * 100) + '%'}${m.error ? ' ERR ' + m.error : ''}`).join(' ');
    if (line !== last) { last = line; console.log(line); }
  });
  await models.download();
  console.log('terminé', models.list().map((m) => `${m.id}:${m.installed}`).join(' '));
}
