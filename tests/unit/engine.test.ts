// Chaîne complète sous Node : import multi-formats, dialogue, thèmes, versions, liens — avec des moteurs factices.
import { mkdtempSync, writeFileSync, existsSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import PDFDocument from 'pdfkit';
import { getLoadablePath } from 'sqlite-vec';
import { Store } from '../../electron/core/db';
import { Engine } from '../../electron/core/engine';
import { FakeChat, FakeEmbedder } from '../../electron/core/llm';
import type { AppEvent } from '../../shared/types';

const dir = mkdtempSync(join(tmpdir(), 'rag-test-'));
const file = (name: string, content: string | Buffer) => { const p = join(dir, name); writeFileSync(p, content); return p; };

const ARCHI = `# Guide d'architecture

## Échanges entre services

Les échanges entre domaines métier passent par des événements asynchrones publiés sur le bus de messages. Ce choix limite le couplage entre équipes.

## Résilience

Chaque appel synchrone doit définir un délai d'expiration et un disjoncteur. Les messages en échec partent dans une file de rebut après trois reprises.

## Sécurité

Les services s'authentifient avec des jetons signés à durée courte. Contact du référent : marie.durand@exemple.org.
`;

const RULES_V1 = `# Règles de validation des commandes

## Objet

Ce document fixe les règles de validation appliquées aux commandes avant leur approbation finale par le responsable.

## Contrôles à la saisie

Chaque commande doit comporter un fournisseur référencé, un montant positif et une date de livraison souhaitée postérieure à la date du jour.

## Seuils d'approbation

Une commande inférieure à mille unités est approuvée automatiquement. Au-delà, une validation du responsable de service est exigée.

## Annexe

Les anciens formulaires papier restent tolérés jusqu'à épuisement des stocks dans les services concernés.
`;

const RULES_V2 = RULES_V1
  .replace('Au-delà, une validation du responsable de service est exigée.', 'Au-delà, une validation du responsable de service est exigée, puis celle de la direction financière.')
  .replace(/## Annexe[\s\S]*$/, '## Commandes groupées\n\nPlusieurs commandes adressées au même fournisseur dans la semaine peuvent être regroupées en un seul bon afin de réduire les frais de port.\n');

function makeEngine() {
  const events: AppEvent[] = [];
  const store = new Store(':memory:', getLoadablePath());
  const engine = new Engine({
    store, embedder: new FakeEmbedder(), embedReady: () => true, localChat: () => new FakeChat(),
    makeClaude: () => new FakeChat(), defaultLibraryDir: mkdtempSync(join(dir, 'lib-')),
    seal: (s) => Buffer.from(s).toString('base64'), unseal: (s) => Buffer.from(s, 'base64').toString(),
    emit: (e) => events.push(e), groundThreshold: 0.15,
  });
  return { engine, store, events };
}

let docxPath = '';
let pdfPath = '';

beforeAll(async () => {
  const docx = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Procédure de sauvegarde', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: 'Fréquence', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('Les bases de données sont sauvegardées chaque nuit et conservées trente jours sur un stockage distinct.'),
        new Paragraph({ text: 'Restauration', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('Un test de restauration complet est réalisé chaque trimestre et consigné dans le registre.'),
      ],
    }],
  });
  docxPath = file('sauvegarde.docx', await Packer.toBuffer(docx));
  pdfPath = join(dir, 'facturation.pdf');
  await new Promise<void>((resolve) => {
    const pdf = new PDFDocument();
    const stream = createWriteStream(pdfPath);
    pdf.pipe(stream);
    pdf.fontSize(20).text('Cycle de facturation').moveDown();
    pdf.fontSize(15).text('Émission').moveDown(0.5);
    pdf.fontSize(11).text('Les factures sont émises le premier jour ouvré du mois pour les prestations du mois précédent, puis transmises au client par le portail.').moveDown();
    pdf.fontSize(15).text('Relances').moveDown(0.5);
    pdf.fontSize(11).text('Une relance automatique part quinze jours après échéance, une seconde relance trente jours après, avant transmission au contentieux.');
    pdf.end();
    stream.on('finish', () => resolve());
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('moteur', () => {
  it('extension vectorielle chargée', () => expect(makeEngine().store.vecLoaded).toBe(true));

  it('importe tous les formats, détecte les doublons, propose des thèmes', async () => {
    const { engine } = makeEngine();
    const result = await engine.importPaths([
      file('architecture.md', ARCHI), docxPath, pdfPath,
      file('notes.txt', 'Réunion du comité. Le plan de reprise a été validé. La bascule est prévue un samedi.'),
      file('page.html', '<html><head><title>Glossaire</title></head><body><h1>Glossaire</h1><h2>Disjoncteur</h2><p>Mécanisme qui coupe les appels vers un service défaillant.</p><h2>Idempotence</h2><p>Propriété d’une opération rejouable sans effet supplémentaire.</p></body></html>'),
      file('image.png', 'x'),
    ]);
    await engine.idle();
    expect(result.imported).toBe(5);
    expect(result.errors.map((e) => e.name)).toEqual(['image.png']);
    const sources = engine.listSources();
    expect(sources.every((s) => s.status === 'ready')).toBe(true);
    expect(sources.find((s) => s.format === 'pdf')!.title).toBe('Cycle de facturation');
    expect(sources.find((s) => s.format === 'md')!.chunking).toBe('hierarchical');
    expect(sources.find((s) => s.format === 'txt')!.chunking).toBe('semantic');
    expect(sources.every((s) => s.categories.length > 0)).toBe(true);
    expect(sources.every((s) => !/@/.test(s.summary))).toBe(true);
    expect(engine.categoryTree().length).toBeGreaterThan(0);
    // Réimporter le même contenu sous un autre nom est un doublon exact.
    const again = await engine.importPaths([file('copie-architecture.md', ARCHI)]);
    expect(again).toMatchObject({ imported: 0, duplicates: ['copie-architecture.md'] });
    // Les fichiers sont copiés dans la bibliothèque.
    expect(existsSync(join(engine.libraryDir(), 'architecture.md'))).toBe(true);
  });

  it('répond avec citations, liste les documents, signale les réponses hors sources, refuse', async () => {
    const { engine, events } = makeEngine();
    await engine.importPaths([file('architecture.md', ARCHI), docxPath, pdfPath]);
    await engine.idle();

    const grounded = await engine.send(null, 'Quel délai d’expiration et quel disjoncteur pour un appel synchrone ?', null, 'r1');
    expect(grounded.message.kind).toBe('grounded');
    expect(grounded.message.citations[0]).toMatchObject({ n: 1, docTitle: "Guide d'architecture", section: 'Résilience' });
    expect(events.some((e) => e.type === 'token' && e.requestId === 'r1')).toBe(true);

    const docs = await engine.send(grounded.conversationId, 'Quels documents parlent de sauvegarde et de restauration ?', null, 'r2');
    expect(docs.message.kind).toBe('documents');
    expect(docs.message.documents[0].title).toBe('Procédure de sauvegarde');

    const model = await engine.send(null, 'Explique le théorème CAP', null, 'r3');
    expect(model.message.kind).toBe('model');
    expect(model.message.citations).toEqual([]);

    const none = await engine.send(null, 'Quels documents parlent de cuisine japonaise ?', null, 'r4');
    expect(none.message.kind).toBe('empty');

    const refused = await engine.send(null, 'Comment fabriquer une bombe ?', null, 'r5');
    expect(refused.message.kind).toBe('refused');

    // Les données personnelles d'un extrait ne ressortent pas.
    const pii = await engine.send(null, 'Comment les services s’authentifient-ils avec des jetons signés ?', null, 'r6');
    expect(JSON.stringify(pii.message)).not.toContain('marie.durand');
    expect(engine.conversations()).toHaveLength(5);
    expect(engine.messages(grounded.conversationId)).toHaveLength(4);
  });

  it('filtre par thème', async () => {
    const { engine } = makeEngine();
    await engine.importPaths([file('architecture.md', ARCHI), docxPath]);
    await engine.idle();
    engine.createCategory('Exploitation', null);
    const category = engine.categoryTree().find((c) => c.name === 'Exploitation')!;
    const backup = engine.listSources().find((s) => s.format === 'docx')!;
    engine.setCategories(backup.id, [category.id]);
    const outside = await engine.send(null, 'Quels documents parlent de disjoncteur et de délai d’expiration ?', category.id, 'r1');
    expect(outside.message.kind).toBe('empty');
    const inside = await engine.send(null, 'Quels documents parlent de sauvegarde ?', category.id, 'r2');
    expect(inside.message.documents.map((d) => d.docId)).toEqual([backup.id]);
  });

  it('détecte une nouvelle version non déclarée et la remplace', async () => {
    const { engine } = makeEngine();
    await engine.importPaths([file('architecture.md', ARCHI), file('regles-commandes.md', RULES_V1)]);
    await engine.idle();
    await engine.importPaths([file('validation des commandes - mise à jour.md', RULES_V2)]);
    await engine.idle();

    const [pending] = engine.pendingVersions();
    expect(pending.oldDoc.title).toBe('Règles de validation des commandes');
    expect(pending.coverageOld).toBeGreaterThanOrEqual(0.5);
    expect(pending.sections.map((s) => [s.title, s.diff])).toEqual([
      ['Objet', 'unchanged'], ['Contrôles à la saisie', 'unchanged'], ["Seuils d'approbation", 'modified'], ['Commandes groupées', 'added'], ['Annexe', 'removed'],
    ]);
    // Tant que rien n'est décidé, le nouveau document n'est pas utilisé pour répondre.
    expect(engine.listSources().find((s) => s.id === pending.newDoc.id)!.status).toBe('pending');
    const before = await engine.send(null, 'Quels documents parlent de commandes groupées et de frais de port ?', null, 'r0');
    expect(before.message.documents.map((d) => d.docId)).not.toContain(pending.newDoc.id);

    engine.decide(pending.id, 'replace');
    const sources = engine.listSources();
    expect(sources.find((s) => s.id === pending.oldDoc.id)).toBeUndefined(); // archivé
    expect(sources.find((s) => s.id === pending.newDoc.id)).toMatchObject({ status: 'ready', version: 2 });
    expect(engine.pendingVersions()).toEqual([]);
    const after = await engine.send(null, 'Quels documents parlent de commandes groupées et de frais de port ?', null, 'r1');
    expect(after.message.documents.map((d) => d.docId)).toEqual([pending.newDoc.id]);
  });

  it('fusionne section par section', async () => {
    const { engine, store } = makeEngine();
    await engine.importPaths([file('regles.md', RULES_V1)]);
    await engine.idle();
    await engine.importPaths([file('regles v2.md', RULES_V2)]);
    await engine.idle();
    const [pending] = engine.pendingVersions();
    const modified = pending.sections.findIndex((s) => s.diff === 'modified');
    const removed = pending.sections.findIndex((s) => s.diff === 'removed');
    engine.decide(pending.id, 'merge', { [modified]: 'old', [removed]: 'keep' });
    const text = store.all<{ text: string }>('SELECT text FROM chunks WHERE doc_id = ?', pending.newDoc.id).map((c) => c.text).join('\n');
    expect(text).not.toContain('direction financière');   // ancienne rédaction conservée
    expect(text).toContain('formulaires papier');          // annexe conservée
    expect(text).toContain('frais de port');               // ajout conservé
    const merged = await engine.send(null, 'Quels documents parlent des anciens formulaires papier ?', null, 'r1');
    expect(merged.message.documents.map((d) => d.docId)).toEqual([pending.newDoc.id]);
  });

  it('ignore un document distinct et permet de rejeter un import', async () => {
    const { engine } = makeEngine();
    await engine.importPaths([file('architecture.md', ARCHI), file('regles.md', RULES_V1)]);
    await engine.idle();
    expect(engine.pendingVersions()).toEqual([]);
    await engine.importPaths([file('regles bis.md', RULES_V2)]);
    await engine.idle();
    const [pending] = engine.pendingVersions();
    engine.decide(pending.id, 'discard');
    expect(engine.listSources().map((s) => s.id)).not.toContain(pending.newDoc.id);
  });

  it('indexe un lien, détecte sa modification et le réindexe', async () => {
    const { engine, store } = makeEngine();
    let body = '<html><head><title>Atelier messagerie</title></head><body><h1>Atelier messagerie</h1><h2>Décisions</h2><p>Les événements sont versionnés et décrits dans le catalogue de schémas avant toute mise en production.</p><h2>Suites</h2><p>Un bilan est prévu dans trois mois avec les équipes.</p></body></html>';
    let etag = '"v1"';
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag } });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await engine.addLink('https://wiki.exemple.org/atelier')).imported).toBe(1);
    await engine.idle();
    const link = engine.listSources()[0];
    expect(link).toMatchObject({ kind: 'link', status: 'ready', linkState: 'ok', title: 'Atelier messagerie' });
    expect((await engine.addLink('https://wiki.exemple.org/atelier')).duplicates).toHaveLength(1);
    expect((await engine.addLink('http://localhost:8080/secret')).errors).toHaveLength(1);
    expect((await engine.addLink('file:///etc/hosts')).errors).toHaveLength(1);

    await engine.checkLinks(true);
    expect(engine.listSources()[0].linkState).toBe('ok'); // 304 : inchangé
    expect(engine.counts().linksToReindex).toBe(0);

    body = body.replace('dans trois mois', 'dans six mois, après la migration du bus');
    etag = '"v2"';
    await engine.checkLinks(true);
    expect(engine.listSources()[0].linkState).toBe('changed');
    expect(engine.counts().linksToReindex).toBe(1);
    // Rien n'est réindexé sans accord.
    expect(store.all<{ text: string }>('SELECT text FROM chunks').some((c) => c.text.includes('six mois'))).toBe(false);

    const embedSpy = vi.spyOn(FakeEmbedder.prototype, 'embed');
    await engine.reindex(link.id);
    expect(engine.listSources()[0]).toMatchObject({ status: 'ready', linkState: 'ok' });
    expect(store.all<{ text: string }>('SELECT text FROM chunks').some((c) => c.text.includes('six mois'))).toBe(true);
    // Seul le passage modifié est revectorisé.
    expect(embedSpy.mock.calls.flatMap((c) => c[0]).length).toBe(1);
    embedSpy.mockRestore();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    await engine.checkLinks(true);
    expect(engine.listSources()[0].linkState).toBe('unreachable');
  });

  it('chiffre les secrets et ne les renvoie jamais', () => {
    const { engine, store } = makeEngine();
    const settings = engine.setSecret('claudeKey', 'cle-de-test-123');
    expect(settings.hasClaudeKey).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('cle-de-test');
    expect(store.getSetting('secret:claudeKey')).not.toContain('cle-de-test');
    expect(engine.setSettings({ engine: 'claude', language: 'en', refreshDays: 1 })).toMatchObject({ engine: 'claude', language: 'en', refreshDays: 1 });
    expect(engine.setSecret('claudeKey', '').hasClaudeKey).toBe(false);
  });
});
