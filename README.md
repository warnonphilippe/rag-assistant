# Assistant RAG

Application de bureau (Angular + Electron) pour interroger une base de connaissances technique et métier : documents PDF, DOCX, Markdown, HTML, texte, et liens (pages web, Confluence).

- **Dialogue** : posez une question, obtenez une réponse rédigée avec ses sources citées.
- **Liste de documents** : demandez « quels documents parlent de… », obtenez la liste des documents concernés.
- **Thèmes** : les documents sont classés par thèmes (proposés à l'indexation, modifiables) et consultables par navigation.
- **Local par défaut** : la vectorisation et le dialogue tournent sur la machine avec des modèles Qwen gratuits. Une clé API Claude peut être utilisée pour le dialogue.

## Démarrage

Prérequis : Node.js 22 ou plus récent, macOS (Apple Silicon) pour la version empaquetée.

```bash
npm install
npm start
```

Au premier lancement, l'application propose de télécharger les deux modèles locaux (environ 3,4 Go, une seule fois) :

| Rôle | Modèle | Taille |
|---|---|---|
| Vectorisation | Qwen3 Embedding 0.6B (Q8) | 0,64 Go |
| Dialogue | Qwen 3.5 4B (Q4_K_M) | 2,7 Go |

Les données (base, modèles, copies des documents) sont stockées dans le dossier de données de l'application.

## Architecture

```
Interface Angular (bac à sable, aucune API Node)
      │  IPC typé, canaux en liste blanche, charge utile validée (zod)
Processus principal Electron
  └─ electron/core/        moteur sans dépendance à Electron (testable sous Node)
       parsers.ts          PDF, DOCX, Markdown, HTML, texte → blocs (titres + texte)
       chunker.ts          découpage hiérarchique, repli sémantique
       db.ts               SQLite (node:sqlite) + FTS5 + sqlite-vec
       llm.ts              modèles locaux (node-llama-cpp), Claude, moteurs de test
       rag.ts              intention, recherche hybride, réponse citée
       versioning.ts       détection de nouvelles versions et fusion
       links.ts            récupération des liens, Confluence, requêtes conditionnelles
       guardrails.ts       données personnelles, modération, politique réseau
       engine.ts           orchestration (sources, thèmes, conversations, paramètres)
shared/types.ts            contrat IPC partagé
src/app/                   écrans : Dialogue, Bibliothèque, Thèmes, Paramètres
```

### Indexation

1. Chaque format est ramené à une suite de blocs (titres et texte).
2. **Découpage hiérarchique** : l'arbre des titres donne les sections ; chaque section est découpée en feuilles d'environ 350 tokens, vectorisées avec leur fil d'Ariane (`Document > Section > Sous-section`).
3. **Repli sémantique** : si le document n'a pas (ou peu) de titres, ou si une section dépasse environ 1 500 tokens, le texte est découpé là où la similarité entre phrases voisines chute ; les groupes obtenus deviennent des pseudo-sections titrées par le modèle. La colonne « Découpage » de la bibliothèque indique le mode retenu (hiérarchique, sémantique, mixte).
4. Le modèle propose un résumé et un à trois thèmes par document.
5. À la réindexation, un passage inchangé conserve son vecteur.

### Dialogue

1. **Intention** : heuristiques (FR/EN), puis classement par le modèle si la demande est ambiguë.
2. **Recherche hybride** : cosinus sur les vecteurs (sqlite-vec) et BM25 (FTS5), fusion par rangs réciproques.
3. **Réponse** : rédigée uniquement à partir des extraits, avec renvois `[n]`.
4. **Hors sources** : si aucun extrait n'est assez proche, ou si le modèle constate que les extraits ne répondent pas, la réponse vient des connaissances du modèle et un bandeau le signale.

## Mise à jour d'un document : détection de version

Quand un fichier est importé sans indiquer qu'il remplace un document existant, l'application le compare aux documents déjà indexés :

| Étape | Signal | Effet |
|---|---|---|
| 1 | Contenu identique (hash) | Doublon exact : import ignoré |
| 2 | Nom normalisé identique (sans version, date, « final »…) ou vecteurs « document » proches | Candidat |
| 3 | Couverture feuille à feuille dans les deux sens (hash identique ou cosinus ≥ 0,85) | Diagnostic |

Diagnostic : **nouvelle version** (couvertures hautes dans les deux sens), **version enrichie** (le nouveau contient l'ancien), **extrait** (l'ancien contient le nouveau), **recouvrement partiel**. En dessous de 50 % dans les deux sens, les documents sont considérés comme distincts.

L'import est alors mis en attente et un écran présente la comparaison par section (inchangée, modifiée, ajoutée, supprimée) avec quatre décisions : **remplacer** (l'ancienne version est archivée et n'est plus utilisée pour répondre), **fusionner** section par section, **conserver les deux**, ou **annuler l'import**. Rien n'est remplacé automatiquement.

Les seuils sont dans `electron/core/versioning.ts`.

## Réindexation des liens

Chaque lien garde sa date de vérification, ses en-têtes `ETag` / `Last-Modified` (ou le numéro de version Confluence) et le hash de son contenu. L'application vérifie les liens arrivés à échéance au démarrage puis toutes les heures (périodicité réglable : jour, semaine, mois, jamais) par une requête conditionnelle. Un lien modifié est signalé dans la bibliothèque ; la réindexation est proposée, ou automatique si l'option est activée.

Pour les pages Confluence protégées, renseignez l'adresse du site, un identifiant et un jeton d'API dans les paramètres (accès en lecture seule).

## Garde-fous

- **Aucune action sur la machine ou à distance** : le modèle ne dispose d'aucun outil, il ne produit que du texte. L'application n'exécute aucune commande et n'ouvre aucun programme.
- **Interface isolée** : `contextIsolation`, bac à sable, pas d'intégration Node, politique de sécurité de contenu stricte, navigation et nouvelles fenêtres bloquées, aucune requête réseau depuis la page.
- **Réseau** : uniquement des requêtes GET http(s) vers les liens référencés, le téléchargement des modèles et, si elle est activée, l'API Claude. Les adresses de la machine locale et des services de métadonnées sont refusées.
- **Fichiers** : les documents importés sont copiés dans le dossier de la bibliothèque ; les originaux ne sont jamais modifiés.
- **Données personnelles** : e-mails, téléphones, IBAN, numéros de carte et identifiants nationaux sont masqués dans les réponses, les extraits, les résumés et dans le texte transmis au modèle.
- **Contenus refusés** : violence, sexisme, discrimination, propos offensants, secrets, illégalité, danger, politique, religion (filtre en entrée et en sortie, plus consigne système).
- **Secrets** : la clé Claude et le jeton Confluence sont chiffrés par le trousseau du système et ne sont jamais renvoyés à l'interface.

## Tests

```bash
npm test             # tests unitaires et d'intégration du moteur (moteurs factices)
npm run test:e2e     # parcours complet dans l'application Electron (moteurs factices)
npm run test:models  # chaîne complète avec les vrais modèles locaux (doivent être installés)
node tests/e2e/real.mjs   # application + vrais modèles
```

## Empaquetage (macOS)

```bash
npm run dist
```

Produit `release/Assistant-RAG-<version>-arm64.dmg`. L'application est signée avec le certificat « Developer ID Application » présent dans le trousseau. La notarisation Apple n'est pas activée par défaut : voir `build.mac.notarize` dans `package.json`.

## Limites connues

- Les PDF numérisés (images sans texte) ne sont pas pris en charge : pas de reconnaissance de caractères.
- Les pages web dont le contenu est produit par JavaScript ne sont pas rendues ; seul le HTML reçu est analysé.
- Le filtre de contenus est fondé sur des listes de termes et sur la consigne donnée au modèle : il peut refuser à tort une question technique contenant un terme sensible.
