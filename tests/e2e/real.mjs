// Vérification de l'application avec les vrais modèles locaux (déjà installés) dans un dossier de données temporaire.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { modelsDir } from '../models/download.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, 'tests', 'e2e', 'screenshots');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'rag-real-'));
mkdirSync(join(work, 'data'));
symlinkSync(modelsDir, join(work, 'data', 'models'));
const doc = join(work, 'guide-architecture.md');
writeFileSync(doc, `# Guide d'architecture\n\n## Échanges entre services\n\nLes échanges entre domaines métier passent par des événements asynchrones publiés sur le bus de messages. Les appels REST synchrones restent admis pour les lectures à l'intérieur d'un même domaine.\n\n## Résilience\n\nChaque appel synchrone doit définir un délai d'expiration de deux secondes et un disjoncteur. Les messages en échec partent dans une file de rebut après trois reprises.\n`);

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, RAG_FAKE_LLM: '', RAG_DATA_DIR: join(work, 'data') } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByTestId('nav-chat').waitFor();
  assert.match(await page.getByTestId('engine').innerText(), /Qwen/);
  assert.equal(await page.getByTestId('setup').count(), 0);
  await page.evaluate((p) => window.api.invoke('sources:importPaths', { paths: [p] }), doc);
  await page.getByTestId('nav-library').click();
  await page.locator('tr[data-status=ready]').waitFor({ timeout: 120000 });
  await page.screenshot({ path: join(shots, 'reel-bibliotheque.png') });
  await page.getByTestId('nav-chat').click();
  const ask = async (text) => {
    await page.getByTestId('chat-input').fill(text);
    const before = await page.locator('article.answer').count();
    await page.getByTestId('chat-send').click();
    const answer = page.locator('article.answer[data-kind]').nth(before);
    await answer.waitFor({ timeout: 120000 });
    return answer;
  };
  const a1 = await ask('Quel est le délai d’expiration d’un appel synchrone ?');
  assert.equal(await a1.getAttribute('data-kind'), 'grounded');
  assert.match(await a1.innerText(), /deux secondes/);
  const a2 = await ask('Explique en deux phrases le théorème CAP.');
  assert.equal(await a2.getAttribute('data-kind'), 'model');
  await page.screenshot({ path: join(shots, 'reel-dialogue.png') });
  console.log('Application + vrais modèles : réussi.');
} finally {
  await app.close();
}
