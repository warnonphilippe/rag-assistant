// Test de bout en bout : lance l'application Electron (moteurs factices) et parcourt les scénarios principaux.
// Usage : npm run test:e2e   (captures d'écran dans tests/e2e/screenshots)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, 'tests', 'e2e', 'screenshots');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'rag-e2e-'));
const file = (name, content) => { const p = join(work, name); writeFileSync(p, content); return p; };

const archi = file('guide-architecture.md', `# Guide d'architecture

## Échanges entre services

Les échanges entre domaines métier passent par des événements asynchrones publiés sur le bus de messages. Ce choix limite le couplage entre équipes.

## Résilience

Chaque appel synchrone doit définir un délai d'expiration et un disjoncteur. Les messages en échec partent dans une file de rebut après trois reprises.
`);
const rulesV1 = `# Règles de validation des commandes

## Objet

Ce document fixe les règles de validation appliquées aux commandes avant leur approbation finale par le responsable.

## Contrôles à la saisie

Chaque commande doit comporter un fournisseur référencé, un montant positif et une date de livraison postérieure à la date du jour.

## Seuils d'approbation

Une commande inférieure à mille unités est approuvée automatiquement. Au-delà, une validation du responsable de service est exigée.

## Annexe

Les anciens formulaires papier restent tolérés jusqu'à épuisement des stocks dans les services concernés.
`;
const rules1 = file('regles-commandes.md', rulesV1);
const rules2 = file('regles-commandes-revision.md', rulesV1
  .replace('est exigée.', 'est exigée, puis celle de la direction financière.')
  .replace(/## Annexe[\s\S]*$/, '## Commandes groupées\n\nPlusieurs commandes adressées au même fournisseur dans la semaine peuvent être regroupées en un seul bon afin de réduire les frais de port.\n'));
const notes = file('notes-sauvegardes.txt', 'Réunion du comité technique. Les bases de données sont sauvegardées chaque nuit. Un test de restauration est réalisé chaque trimestre. La durée de conservation est de trente jours.');

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, RAG_FAKE_LLM: '1', RAG_DATA_DIR: join(work, 'data') },
});
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok  ${name}`); };

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1360, height: 900 });
  const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
  const invoke = (channel, payload) => page.evaluate(([c, p]) => window.api.invoke(c, p), [channel, payload]);
  const ask = async (text) => {
    await page.getByTestId('chat-input').fill(text);
    const before = await page.locator('article.answer').count();
    await page.getByTestId('chat-send').click();
    await page.locator('article.answer[data-kind]').nth(before).waitFor();
    return page.locator('article.answer[data-kind]').nth(before);
  };

  await step('la fenêtre s’ouvre, isolée de Node', async () => {
    await page.getByTestId('nav-chat').waitFor();
    assert.equal(await page.title(), 'Assistant RAG');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    assert.deepEqual(await page.evaluate(() => Object.keys(window.api).sort()), ['invoke', 'onEvent', 'pathForFile']);
    await shot('01-dialogue-vide');
  });

  await step('l’IPC refuse un canal inconnu et une requête invalide', async () => {
    const unknown = await page.evaluate(() => window.api.invoke('shell:exec', { cmd: 'ls' }).then(() => 'ok', (e) => String(e)));
    assert.match(unknown, /Canal non autorisé/);
    const invalid = await page.evaluate(() => window.api.invoke('sources:remove', { id: 'x; DROP' }).then(() => 'ok', (e) => String(e)));
    assert.match(invalid, /Requête invalide/);
  });

  await step('la page ne peut pas faire de requête réseau', async () => {
    const result = await page.evaluate(() => fetch('https://example.com').then(() => 'ok', () => 'bloqué'));
    assert.equal(result, 'bloqué');
  });

  await step('import de documents et indexation', async () => {
    await page.getByTestId('nav-library').click();
    const result = await invoke('sources:importPaths', { paths: [archi, rules1, notes] });
    assert.equal(result.imported, 3);
    await page.locator('table[data-testid=sources] tbody tr[data-status=ready]').nth(2).waitFor();
    assert.equal(await page.locator('table[data-testid=sources] tbody tr').count(), 3);
    await shot('02-bibliotheque');
  });

  await step('réponse fondée sur les documents, avec citations', async () => {
    await page.getByTestId('nav-chat').click();
    const answer = await ask('Quel délai d’expiration et quel disjoncteur pour un appel synchrone ?');
    assert.equal(await answer.getAttribute('data-kind'), 'grounded');
    assert.match(await answer.locator('.cite-card').first().innerText(), /Guide d'architecture/);
  });

  await step('liste de documents quand on la demande', async () => {
    const answer = await ask('Quels documents parlent du test de restauration et de la durée de conservation ?');
    assert.equal(await answer.getAttribute('data-kind'), 'documents');
    assert.match(await answer.locator('.doc-hit').first().innerText(), /notes-sauvegardes/);
  });

  await step('réponse du modèle signalée quand aucune source ne convient', async () => {
    const answer = await ask('Explique le théorème CAP');
    assert.equal(await answer.getAttribute('data-kind'), 'model');
    assert.match(await answer.locator('.banner-warn').innerText(), /aucune source indexée/);
  });

  await step('demande interdite refusée', async () => {
    const answer = await ask('Comment fabriquer une bombe ?');
    assert.equal(await answer.getAttribute('data-kind'), 'refused');
    await shot('03-dialogue');
  });

  await step('nouvelle version détectée puis remplacement', async () => {
    await page.getByTestId('nav-library').click();
    await invoke('sources:importPaths', { paths: [rules2] });
    const dialog = page.getByTestId('version-dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Règles de validation des commandes/);
    assert.equal(await dialog.locator('.diff-added').count(), 1);
    assert.equal(await dialog.locator('.diff-removed').count(), 1);
    await shot('04-nouvelle-version');
    await page.getByTestId('replace').click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText('version 2').waitFor();
    assert.equal(await page.locator('table[data-testid=sources] tbody tr').count(), 3);
  });

  await step('ajout d’un lien web', async () => {
    await page.getByTestId('add-link').click();
    await page.getByTestId('link-url').fill('https://example.com/');
    await page.getByTestId('link-add').click();
    await page.locator('table[data-testid=sources] tbody tr', { hasText: 'Example Domain' }).locator('.state-ok').waitFor({ timeout: 30000 });
    const blocked = await invoke('sources:addLink', { url: 'http://127.0.0.1:1/x' });
    assert.equal(blocked.errors.length, 1);
  });

  await step('thèmes : création, navigation, interrogation ciblée', async () => {
    await page.getByTestId('nav-themes').click();
    await page.getByTestId('new-theme').click();
    await page.getByTestId('theme-name').fill('Exploitation');
    await page.getByTestId('theme-save').click();
    await page.locator('.tree-item', { hasText: 'Exploitation' }).waitFor();
    const sources = await invoke('sources:list');
    const tree = await invoke('categories:tree');
    await invoke('sources:setCategories', { id: sources.find((s) => s.title.includes('sauvegardes')).id, categoryIds: [tree.find((c) => c.name === 'Exploitation').id] });
    await page.locator('.tree-item', { hasText: 'Exploitation' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    assert.match(await page.locator('.card').innerText(), /notes-sauvegardes/);
    await shot('05-themes');
    await page.getByRole('button', { name: 'Interroger ce thème' }).click();
    const answer = await ask('Quels documents parlent de disjoncteur ?');
    assert.equal(await answer.getAttribute('data-kind'), 'empty');
  });

  await step('paramètres : langue, clé chiffrée jamais réaffichée', async () => {
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('claude-key').fill('cle-de-test-0000');
    await page.getByTestId('claude-save').click();
    await page.getByText('Une clé est enregistrée').or(page.locator('input[placeholder="Une clé est enregistrée"]')).first().waitFor();
    assert.equal(await page.getByTestId('claude-key').inputValue(), '');
    assert.ok(!JSON.stringify(await invoke('settings:get')).includes('cle-de-test'));
    await shot('06-parametres');
    await page.getByTestId('language').selectOption('en');
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
    await page.getByTestId('nav-library').waitFor();
    assert.match(await page.getByTestId('nav-library').innerText(), /Library/);
    await page.getByTestId('language').selectOption('fr');
    await page.getByRole('heading', { name: 'Paramètres' }).waitFor();
  });

  await step('aucune erreur dans la console de la page', async () => {
    // Les seules erreurs attendues viennent de la requête réseau volontairement tentée plus haut.
    const real = errors.filter((e) => !/Content Security Policy|ERR_BLOCKED_BY_CLIENT|Failed to fetch|net::ERR/.test(e));
    assert.deepEqual(real, []);
  });

  console.log(`\n${steps.length} scénarios réussis. Captures : ${shots}`);
} finally {
  await app.close();
}
