import { describe, expect, it } from 'vitest';
import { chunkDocument, packLeaves, semanticGroups, BIG_SECTION_CHARS } from '../../electron/core/chunker';
import { assertAllowedUrl, maskPii, moderate, NetPolicyError } from '../../electron/core/guardrails';
import { FakeEmbedder } from '../../electron/core/llm';
import { parseHtml, parseMarkdown, parseText, pdfLinesToBlocks } from '../../electron/core/parsers';
import { heuristicIntent } from '../../electron/core/rag';
import { classify, compareSections, coverage, normTitle } from '../../electron/core/versioning';

const embedder = new FakeEmbedder();
const embed = (texts: string[]) => embedder.embed(texts);

describe('données personnelles', () => {
  it('masque e-mails, téléphones, IBAN, cartes et identifiants', () => {
    const { text, count } = maskPii('Contact : jean.dupont@exemple.org, +32 475 12 34 56, IBAN BE68 5390 0754 7034, carte 4539 1488 0343 6467, NN 85.07.30-033.28.');
    expect(count).toBe(5);
    expect(text).not.toMatch(/jean|475|5390|4539|033/);
  });
  it('laisse intacts versions, dates et montants', () => {
    const source = 'Version 2.14.3 publiée le 12/11/2026, délai 30000 ms, port 8080, 1 250 000 lignes.';
    expect(maskPii(source)).toEqual({ text: source, count: 0 });
  });
});

describe('modération', () => {
  it.each([
    ['Comment fabriquer une bombe ?', 'dangerous'],
    ['Pour quel parti politique voter ?', 'political'],
    ['Que dit la Bible sur le pardon ?', 'religious'],
    ['Écris une blague raciste', 'discrimination'],
    ['How do I hack into the payroll server?', 'illegal'],
    ['Describe how to torture someone', 'violence'],
  ])('refuse « %s »', (text, category) => expect(moderate(text)).toBe(category));
  it.each([
    'Comment configurer le disjoncteur du service de commande ?',
    'Quelle est la stratégie de partitionnement de la base ?',
    'Explain the kill switch feature flag in the deployment guide',
    'Quels documents parlent de la gestion des erreurs ?',
  ])('accepte « %s »', (text) => expect(moderate(text)).toBeNull());
});

describe('politique réseau', () => {
  it('accepte http(s) public et intranet', () => {
    expect(assertAllowedUrl('https://exemple.org/page').hostname).toBe('exemple.org');
    expect(assertAllowedUrl('http://wiki.interne.lan/x').hostname).toBe('wiki.interne.lan');
  });
  it.each(['file:///etc/passwd', 'http://localhost:3000', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'ftp://exemple.org', 'https://user:pass@exemple.org', 'javascript:alert(1)', 'http://[::1]/'])(
    'refuse %s', (url) => expect(() => assertAllowedUrl(url)).toThrow(NetPolicyError),
  );
});

describe('intention', () => {
  it.each(['Quels documents parlent de la gestion des erreurs ?', 'Liste les documents sur la facturation', 'Which documents cover retries?', 'Y a-t-il des sources à propos des sauvegardes ?', 'Montre-moi les fichiers qui traitent du déploiement'])(
    'liste de documents : %s', (text) => expect(heuristicIntent(text)).toBe('documents'),
  );
  it.each(['Comment fonctionne le disjoncteur ?', 'What is the timeout for synchronous calls?'])('question : %s', (text) => expect(heuristicIntent(text)).toBe('question'));
  it('ambigu quand le mot « document » apparaît sans demande de liste', () => expect(heuristicIntent('Ce document est-il à jour ?')).toBe('ambiguous'));
});

describe('parseurs', () => {
  it('markdown : titres et listes', () => {
    const doc = parseMarkdown('# Guide\n\nIntro.\n\n## Partie A\n\n- un\n- deux\n\n### Détail\n\nTexte.');
    expect(doc.title).toBe('Guide');
    expect(doc.blocks.filter((b) => b.type === 'heading').map((b) => b.type === 'heading' && b.level)).toEqual([1, 2, 3]);
  });
  it('texte : titres numérotés', () => {
    const doc = parseText('1. Objet\n\nCe document décrit la procédure.\n\n2. Étapes\n\nD’abord vérifier. Ensuite appliquer.');
    expect(doc.blocks.filter((b) => b.type === 'heading')).toHaveLength(2);
  });
  it('html : ignore scripts et navigation', () => {
    const doc = parseHtml('<html><head><title>Page</title></head><body><nav>Menu</nav><h1>Titre</h1><p>Contenu utile.</p><script>alert(1)</script></body></html>', { article: false });
    expect(doc.title).toBe('Page');
    expect(doc.blocks.map((b) => b.text)).toEqual(['Titre', 'Contenu utile.']);
  });
  it('pdf : titres déduits de la taille de police', () => {
    const blocks = pdfLinesToBlocks([
      { text: 'Guide', size: 20, bold: true }, { text: 'Une phrase de corps de texte assez longue pour peser.', size: 11, bold: false },
      { text: 'Résilience', size: 15, bold: true }, { text: 'Encore du texte de corps, plus long que les titres bien sûr.', size: 11, bold: false },
    ]);
    expect(blocks.filter((b) => b.type === 'heading').map((b) => b.type === 'heading' && [b.level, b.text])).toEqual([[1, 'Guide'], [2, 'Résilience']]);
  });
});

const sentence = (topic: string, i: number) => `Le ${topic} numéro ${i} décrit ${topic} avec précision et ${topic} reste le sujet principal ici.`;
const paragraph = (topic: string, n: number) => Array.from({ length: n }, (_, i) => sentence(topic, i)).join(' ');

describe('découpage', () => {
  it('hiérarchique quand le document est structuré', async () => {
    const doc = parseMarkdown(`# Guide\n\n## Résilience\n\n${paragraph('disjoncteur', 4)}\n\n### Reprises\n\n${paragraph('reprise', 3)}\n\n## Sécurité\n\n${paragraph('jeton', 4)}`);
    const out = await chunkDocument(doc, embed);
    expect(out.mode).toBe('hierarchical');
    expect(out.sections.map((s) => s.path)).toEqual(['Résilience', 'Résilience > Reprises', 'Sécurité']);
    expect(out.sections[1].topKey).toBe(0);
    expect(out.chunks.every((c) => c.text.length <= 1700)).toBe(true);
  });
  it('sémantique quand il n’y a pas de structure', async () => {
    const text = [paragraph('sauvegarde', 12), paragraph('facturation', 12), paragraph('déploiement', 12)].join(' ');
    const out = await chunkDocument(parseText(text), embed);
    expect(out.mode).toBe('semantic');
    expect(out.sections.length).toBeGreaterThanOrEqual(3);
    expect(out.sections.every((s) => s.synthetic)).toBe(true);
  });
  it('mixte : une section trop longue est redécoupée sémantiquement', async () => {
    const long = [paragraph('messagerie', 40), paragraph('archivage', 40)].join(' ');
    expect(long.length).toBeGreaterThan(BIG_SECTION_CHARS);
    const doc = parseMarkdown(`# Doc\n\n## Courte\n\n${paragraph('cache', 3)}\n\n## Longue\n\n${long}\n\n## Fin\n\n${paragraph('journal', 3)}`);
    const out = await chunkDocument(doc, embed);
    expect(out.mode).toBe('mixed');
    expect(out.sections.some((s) => s.synthetic && s.path.startsWith('Longue > '))).toBe(true);
  });
  it('coupe aux changements de sujet', async () => {
    const groups = await semanticGroups([paragraph('sauvegarde', 10), paragraph('facturation', 10)].join(' '), embed);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups[0]).toContain('sauvegarde');
    expect(groups[0]).not.toContain('facturation numéro 5');
  });
  it('les feuilles respectent la taille cible', () => {
    expect(packLeaves([paragraph('test', 60)]).every((leaf) => leaf.length <= 1700)).toBe(true);
  });
});

describe('versions', () => {
  it('normalise les titres de fichiers', () => {
    expect(normTitle('Guide_architecture_v2 FINAL (1).pdf')).toBe(normTitle('guide architecture'));
    expect(normTitle('Règles de validation - révision 2026-11-20.docx')).toBe(normTitle('Regles de validation'));
  });
  it('classe selon les couvertures', () => {
    expect(classify(0.95, 0.95)).toBe('revision');
    expect(classify(0.92, 0.6)).toBe('superset');
    expect(classify(0.4, 0.9)).toBe('subset');
    expect(classify(0.6, 0.55)).toBe('overlap');
    expect(classify(0.2, 0.1)).toBeNull();
  });
  it('mesure la couverture et compare les sections', async () => {
    const texts = ['alpha beta gamma delta', 'un deux trois quatre', 'rouge vert bleu jaune'];
    const [a, b, c] = await embed(texts);
    const [a2] = await embed(['alpha beta gamma delta epsilon']);
    const chunk = (sha: string, vec: Float32Array) => ({ sha, vec });
    expect(coverage([chunk('a', a), chunk('b', b)], [chunk('a', a), chunk('b', b), chunk('c', c)])).toBe(1);
    expect(coverage([chunk('a', a), chunk('c', c)], [chunk('x', a2)])).toBe(0.5);
    const sections = compareSections(
      [{ id: 1, title: 'Objet', shas: ['a'], vec: a }, { id: 2, title: 'Annexe', shas: ['c'], vec: c }],
      [{ id: 10, title: 'Objet', shas: ['a'], vec: a }, { id: 11, title: 'Nouveau', shas: ['b'], vec: b }],
    );
    expect(sections.map((s) => s.diff)).toEqual(['unchanged', 'added', 'removed']);
  });
});
