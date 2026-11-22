// Essai avec les vrais modèles locaux (Qwen) : indexation, réponse citée, liste, hors sources, version.
// Usage : npm run test:models   (les modèles doivent être installés ; voir tests/models/download.mjs)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLoadablePath } from 'sqlite-vec';
import { Engine, LocalModels, Store } from '../../dist-electron/core.mjs';
import { modelsDir } from './download.mjs';

const work = mkdtempSync(join(tmpdir(), 'rag-models-'));
const file = (name, content) => { const p = join(work, name); writeFileSync(p, content); return p; };
const models = new LocalModels(modelsDir, () => {});
assert.ok(models.embedReady && models.chatReady, 'modèles non installés');

const store = new Store(':memory:', getLoadablePath());
const engine = new Engine({
  store, embedder: models, embedReady: () => true, localChat: () => models, makeClaude: () => models,
  defaultLibraryDir: join(work, 'lib'), seal: (s) => s, unseal: (s) => s, emit: () => {}, groundThreshold: Number(process.env.RAG_THRESHOLD ?? 0.45),
});

const archi = `# Guide d'architecture

## Échanges entre services

Les échanges entre domaines métier passent par des événements asynchrones publiés sur le bus de messages. Ce choix limite le couplage entre équipes. Les appels REST synchrones restent admis pour les lectures à l'intérieur d'un même domaine.

## Résilience

Chaque appel synchrone doit définir un délai d'expiration de deux secondes et un disjoncteur. Les messages en échec partent dans une file de rebut après trois reprises.

## Sécurité

Les services s'authentifient avec des jetons signés dont la durée de vie est de quinze minutes.
`;
const rules = `# Règles de validation des commandes

## Objet

Ce document fixe les règles de validation appliquées aux commandes avant leur approbation finale par le responsable.

## Contrôles à la saisie

Chaque commande doit comporter un fournisseur référencé, un montant positif et une date de livraison postérieure à la date du jour.

## Seuils d'approbation

Une commande inférieure à mille unités est approuvée automatiquement. Au-delà, une validation du responsable de service est exigée.

## Annexe

Les anciens formulaires papier restent tolérés jusqu'à épuisement des stocks dans les services concernés.
`;
const rules2 = rules
  .replace('Ce document fixe les règles', 'La présente note définit les règles')
  .replace('est exigée.', 'est exigée, puis celle de la direction financière au-delà de dix mille unités.')
  .replace(/## Annexe[\s\S]*$/, '## Commandes groupées\n\nPlusieurs commandes adressées au même fournisseur dans la semaine peuvent être regroupées en un seul bon afin de réduire les frais de port.\n');
const notes = 'Réunion du comité technique consacrée aux sauvegardes. Les bases de données sont sauvegardées chaque nuit sur un stockage distinct. Un test de restauration complet est réalisé chaque trimestre. La durée de conservation des sauvegardes est de trente jours. Par ailleurs, le comité a examiné le budget de formation. Trois sessions sont prévues au printemps. Les inscriptions ouvrent en janvier. Le coût par participant reste inchangé par rapport à l’an dernier.';

let t = Date.now();
const lap = (label) => { console.log(`  (${label} : ${((Date.now() - t) / 1000).toFixed(1)} s)`); t = Date.now(); };

await engine.importPaths([file('guide-architecture.md', archi), file('regles-commandes.md', rules), file('notes-comite.txt', notes)]);
await engine.idle();
lap('indexation de 3 documents');
for (const s of engine.listSources()) console.log(`- ${s.title} [${s.chunking}] thèmes=${s.categories.map((c) => c.name).join(', ')} | ${s.summary}`);
assert.ok(engine.listSources().every((s) => s.categories.length > 0), 'thèmes attendus');
assert.ok(engine.listSources().every((s) => s.status === 'ready'), JSON.stringify(engine.listSources().map((s) => s.error)));

const show = async (q) => {
  const { message } = await engine.send(null, q, null, 'r');
  console.log(`\nQ: ${q}\n→ [${message.kind}] ${message.content.slice(0, 400)}`);
  for (const c of message.citations) console.log(`   [${c.n}] ${c.docTitle} — ${c.section}`);
  for (const d of message.documents) console.log(`   • ${d.title} — ${d.section}`);
  lap('réponse');
  return message;
};

// Similarités observées, pour étalonner le seuil d'ancrage.
for (const q of ['Quel est le délai d’expiration d’un appel synchrone ?', 'What is the lifetime of service tokens?', 'Explique le théorème CAP', 'Quelle est la capitale de l’Australie ?', 'Comment fonctionne un index B-tree ?']) {
  const [v] = await models.embed([q], 'query');
  console.log(`sim max « ${q} » = ${store.vectorSearch(v, 1, null)[0].score.toFixed(3)}`);
}
t = Date.now();

const a1 = await show('Quel est le délai d’expiration d’un appel synchrone et que deviennent les messages en échec ?');
assert.equal(a1.kind, 'grounded');
assert.match(a1.content, /deux secondes|2 secondes|2 s/i);
assert.equal(a1.citations[0].docTitle, "Guide d'architecture");

const a2 = await show('Quels documents parlent des sauvegardes ?');
assert.equal(a2.kind, 'documents');
assert.equal(a2.documents[0].title, 'notes-comite');

const a3 = await show('What is the lifetime of the tokens used by services?');
assert.equal(a3.kind, 'grounded');
assert.match(a3.content, /fifteen|15/i);

const a4 = await show('Explique en deux phrases le théorème CAP.');
assert.equal(a4.kind, 'model');

const a5 = await show('Quelles sont les prochaines élections ?');
assert.equal(a5.kind, 'refused');

await engine.importPaths([file('validation-commandes-maj.md', rules2)]);
await engine.idle();
lap('import de la révision');
const [pending] = engine.pendingVersions();
assert.ok(pending, 'la révision devait être détectée');
console.log(`\nVersion détectée : ancien couvert à ${Math.round(pending.coverageOld * 100)} %, nouveau à ${Math.round(pending.coverageNew * 100)} % → ${pending.verdict}`);
for (const s of pending.sections) console.log(`   ${s.diff.padEnd(9)} ${s.title}`);
assert.equal(pending.oldDoc.title, 'Règles de validation des commandes');
console.log('\nEssai avec les vrais modèles : réussi.');
process.exit(0);
