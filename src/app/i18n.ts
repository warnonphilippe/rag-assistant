import { Injectable, Pipe, PipeTransform, inject, signal } from '@angular/core';

const FR = {
  'nav.chat': 'Dialogue', 'nav.library': 'Bibliothèque', 'nav.themes': 'Thèmes', 'nav.settings': 'Paramètres',
  'nav.main': 'Navigation principale', 'nav.conversations': 'Conversations', 'nav.newConversation': 'Nouvelle conversation',
  'nav.deleteConversation': 'Supprimer la conversation', 'nav.ready': 'prêt', 'nav.notReady': 'non installé', 'nav.noEngine': 'Aucun moteur de dialogue',
  'chat.newTitle': 'Nouvelle conversation', 'chat.allThemes': 'Tous les thèmes', 'chat.sources': 'Sources indexées : {n}', 'chat.themeFilter': 'Thème interrogé',
  'chat.placeholder': 'Posez une question, ou demandez quels documents traitent d’un sujet…', 'chat.send': 'Envoyer', 'chat.question': 'Votre question',
  'chat.hint': 'Les réponses s’appuient en priorité sur vos documents. Avec le modèle local, tout reste sur cet ordinateur.',
  'chat.grounded': 'Réponse fondée sur vos documents', 'chat.model': 'Réponse du modèle — aucune source indexée ne traite ce sujet',
  'chat.modelSource': 'Source : connaissances générales de « {engine} », non vérifiées dans votre bibliothèque.',
  'chat.refused': 'Demande refusée', 'chat.empty': 'Aucun résultat', 'chat.docs': 'Documents trouvés', 'chat.thinking': 'Recherche dans vos documents…',
  'chat.emptyTitle': 'Interrogez votre base de connaissances',
  'chat.emptyText': 'Posez une question pour obtenir une réponse citée, ou demandez « quels documents parlent de… » pour obtenir une liste.',
  'chat.emptyNoSources': 'Commencez par ajouter des documents ou des liens dans la bibliothèque.', 'chat.goLibrary': 'Ouvrir la bibliothèque',
  'chat.error': 'La réponse a échoué : {detail}',
  'kind.file': 'Document', 'kind.link': 'Lien',
  'lib.title': 'Bibliothèque', 'lib.count': '{total} sources · {files} documents, {links} liens', 'lib.addLink': 'Ajouter un lien', 'lib.import': 'Importer des documents',
  'lib.dropTitle': 'Déposez vos fichiers ici', 'lib.dropText': 'PDF, DOCX, Markdown, HTML ou texte — ils sont copiés dans le dossier de la bibliothèque puis indexés.',
  'lib.filter': 'Filtrer par titre…', 'lib.filterLabel': 'Filtrer les sources', 'lib.all': 'Tout', 'lib.files': 'Documents', 'lib.links': 'Liens',
  'lib.colSource': 'Source', 'lib.colThemes': 'Thèmes', 'lib.colChunking': 'Découpage', 'lib.colIndexed': 'Indexé le', 'lib.colState': 'État', 'lib.colActions': 'Actions',
  'lib.changedOne': '1 lien a changé depuis sa dernière indexation.', 'lib.changedMany': '{n} liens ont changé depuis leur dernière indexation.',
  'lib.changedText': 'Réindexez-les pour que les réponses restent à jour.', 'lib.reindexAll': 'Tout réindexer', 'lib.checkLinks': 'Vérifier les liens',
  'lib.pendingOne': '1 import ressemble à une nouvelle version d’un document existant.', 'lib.pendingMany': '{n} imports ressemblent à de nouvelles versions de documents existants.',
  'lib.review': 'Examiner', 'lib.empty': 'Aucune source pour le moment.', 'lib.noMatch': 'Aucune source ne correspond à ce filtre.',
  'lib.linkUrl': 'Adresse de la page', 'lib.linkPlaceholder': 'https://…', 'lib.add': 'Ajouter', 'lib.cancel': 'Annuler',
  'lib.version': 'version {n}', 'lib.checked': 'vérifié le {date}',
  'state.ready': 'À jour', 'state.indexing': 'Indexation…', 'state.error': 'Erreur', 'state.pending': 'Version proche détectée',
  'state.changed': 'Modifié — réindexer', 'state.unreachable': 'Inaccessible',
  'chunk.hierarchical': 'Hiérarchique', 'chunk.semantic': 'Sémantique', 'chunk.mixed': 'Mixte',
  'act.reindex': 'Réindexer', 'act.remove': 'Supprimer', 'act.removeConfirm': 'Supprimer « {title} » de la bibliothèque ?', 'act.themes': 'Modifier les thèmes',
  'import.done': '{n} source(s) ajoutée(s), indexation en cours.', 'import.duplicates': 'Déjà présent : {names}.', 'import.errors': 'Non importé : {names}.',
  'themes.title': 'Thèmes', 'themes.intro': 'Les thèmes sont proposés à l’indexation ; vous pouvez les renommer, en créer ou reclasser un document.',
  'themes.new': 'Nouveau thème', 'themes.newSub': 'Nouveau sous-thème', 'themes.tree': 'Arborescence des thèmes', 'themes.unclassified': 'Non classés', 'themes.all': 'Toutes les sources',
  'themes.count': '{n} sources', 'themes.ask': 'Interroger ce thème', 'themes.rename': 'Renommer', 'themes.delete': 'Supprimer le thème', 'themes.name': 'Nom du thème',
  'themes.empty': 'Aucune source dans ce thème.', 'themes.assign': 'Thèmes de « {title} »', 'themes.save': 'Enregistrer', 'themes.none': 'Aucun thème pour le moment.',
  'ver.eyebrow': 'Import en attente de votre décision', 'ver.title': 'Ce document ressemble à une nouvelle version',
  'ver.intro': 'Le fichier importé recouvre en grande partie un document déjà indexé. Rien n’est remplacé sans votre accord.',
  'ver.existing': 'Déjà dans la bibliothèque', 'ver.imported': 'Fichier importé', 'ver.sections': '{n} sections', 'ver.indexed': 'indexé le {date}',
  'ver.covOld': 'de l’ancien document se retrouve dans le nouveau', 'ver.covNew': 'du nouveau document existait déjà dans l’ancien',
  'ver.verdict.revision': 'Nouvelle version', 'ver.verdict.superset': 'Version enrichie', 'ver.verdict.subset': 'Extrait', 'ver.verdict.overlap': 'Recouvrement partiel',
  'ver.diag.revision': 'diagnostic : même document, révisé', 'ver.diag.superset': 'diagnostic : le nouveau reprend l’ancien et le complète',
  'ver.diag.subset': 'diagnostic : le nouveau est une partie de l’ancien', 'ver.diag.overlap': 'diagnostic : les deux documents se recouvrent en partie',
  'ver.compare': 'Comparaison par section', 'ver.colSection': 'Section', 'ver.colDiff': 'Différence', 'ver.colMerge': 'En cas de fusion',
  'ver.unchanged': 'Inchangée', 'ver.modified': 'Modifiée', 'ver.added': 'Ajoutée', 'ver.removed': 'Supprimée',
  'ver.kept': 'Conservée', 'ver.keepNew': 'Garder la nouvelle', 'ver.keepOld': 'Garder l’ancienne', 'ver.drop': 'Retirer', 'ver.keep': 'Conserver', 'ver.add': 'Ajouter', 'ver.skip': 'Ne pas ajouter',
  'ver.choice': 'Choix pour la section « {title} »',
  'ver.note': 'En cas de remplacement, l’ancienne version est archivée : elle n’est plus utilisée pour répondre.',
  'ver.keepBoth': 'Conserver les deux', 'ver.merge': 'Fusionner selon mes choix', 'ver.replace': 'Remplacer l’ancienne version', 'ver.discard': 'Annuler l’import', 'ver.later': 'Décider plus tard',
  'set.title': 'Paramètres', 'set.engine': 'Moteur de dialogue', 'set.local': 'Modèle local Qwen', 'set.localTag': 'gratuit, intégré',
  'set.localText': 'Tout est calculé sur cet ordinateur. Aucun texte ne sort de la machine.', 'set.claude': 'Claude', 'set.claudeTag': 'avec votre clé API',
  'set.claudeText': 'Les extraits utiles à la réponse sont envoyés à l’API, données personnelles masquées. L’indexation reste locale.',
  'set.claudeKey': 'Clé API Claude', 'set.keyPlaceholder': 'Collez votre clé API', 'set.keySaved': 'Une clé est enregistrée', 'set.save': 'Enregistrer', 'set.clear': 'Effacer',
  'set.keyNote': 'La clé est chiffrée dans le trousseau du système et n’est jamais réaffichée.', 'set.claudeModel': 'Modèle Claude', 'set.needKey': 'Enregistrez une clé pour activer ce moteur.',
  'set.models': 'Modèles installés', 'set.installed': 'Installé', 'set.missing': 'Non installé · {size} Go', 'set.downloading': 'Téléchargement… {pct} %', 'set.download': 'Télécharger les modèles',
  'set.links': 'Liens et réindexation', 'set.check': 'Vérifier les liens', 'set.checkText': 'L’application compare la page à sa dernière version indexée.',
  'set.daily': 'Chaque jour', 'set.weekly': 'Chaque semaine', 'set.monthly': 'Chaque mois', 'set.never': 'Jamais',
  'set.auto': 'Réindexer sans demander', 'set.autoText': 'Désactivé : l’application propose, vous décidez.',
  'set.confluence': 'Connexion Confluence', 'set.optional': 'facultative', 'set.confluenceText': 'Nécessaire uniquement pour les pages protégées. Accès en lecture seule.',
  'set.confluenceUrl': 'Adresse du site', 'set.confluenceUser': 'Identifiant', 'set.confluenceToken': 'Jeton d’API', 'set.tokenSaved': 'Un jeton est enregistré',
  'set.general': 'Général', 'set.language': 'Langue de l’interface', 'set.library': 'Dossier de la bibliothèque', 'set.change': 'Changer…',
  'set.pii': 'Masquer les données personnelles', 'set.piiText': 'E-mails, téléphones et identifiants sont masqués dans les réponses et les extraits.',
  'setup.title': 'Installation des modèles locaux',
  'setup.text': 'L’assistant fonctionne avec deux modèles gratuits exécutés sur cet ordinateur. Ils sont téléchargés une seule fois (environ 3,4 Go).',
  'setup.start': 'Télécharger', 'setup.error': 'Le téléchargement a échoué : {detail}', 'setup.retry': 'Réessayer',
  'common.close': 'Fermer', 'common.error': 'Une erreur est survenue : {detail}',
};

type Key = keyof typeof FR;

const EN: Record<Key, string> = {
  'nav.chat': 'Chat', 'nav.library': 'Library', 'nav.themes': 'Topics', 'nav.settings': 'Settings',
  'nav.main': 'Main navigation', 'nav.conversations': 'Conversations', 'nav.newConversation': 'New conversation',
  'nav.deleteConversation': 'Delete conversation', 'nav.ready': 'ready', 'nav.notReady': 'not installed', 'nav.noEngine': 'No chat engine',
  'chat.newTitle': 'New conversation', 'chat.allThemes': 'All topics', 'chat.sources': 'Indexed sources: {n}', 'chat.themeFilter': 'Topic in scope',
  'chat.placeholder': 'Ask a question, or ask which documents cover a subject…', 'chat.send': 'Send', 'chat.question': 'Your question',
  'chat.hint': 'Answers rely on your documents first. With the local model, everything stays on this computer.',
  'chat.grounded': 'Answer based on your documents', 'chat.model': 'Model answer — no indexed source covers this topic',
  'chat.modelSource': 'Source: general knowledge of “{engine}”, not verified against your library.',
  'chat.refused': 'Request declined', 'chat.empty': 'No result', 'chat.docs': 'Documents found', 'chat.thinking': 'Searching your documents…',
  'chat.emptyTitle': 'Query your knowledge base',
  'chat.emptyText': 'Ask a question to get a cited answer, or ask “which documents cover…” to get a list.',
  'chat.emptyNoSources': 'Start by adding documents or links in the library.', 'chat.goLibrary': 'Open the library',
  'chat.error': 'The answer failed: {detail}',
  'kind.file': 'Document', 'kind.link': 'Link',
  'lib.title': 'Library', 'lib.count': '{total} sources · {files} documents, {links} links', 'lib.addLink': 'Add a link', 'lib.import': 'Import documents',
  'lib.dropTitle': 'Drop your files here', 'lib.dropText': 'PDF, DOCX, Markdown, HTML or text — they are copied to the library folder, then indexed.',
  'lib.filter': 'Filter by title…', 'lib.filterLabel': 'Filter sources', 'lib.all': 'All', 'lib.files': 'Documents', 'lib.links': 'Links',
  'lib.colSource': 'Source', 'lib.colThemes': 'Topics', 'lib.colChunking': 'Chunking', 'lib.colIndexed': 'Indexed on', 'lib.colState': 'Status', 'lib.colActions': 'Actions',
  'lib.changedOne': '1 link has changed since it was last indexed.', 'lib.changedMany': '{n} links have changed since they were last indexed.',
  'lib.changedText': 'Reindex them to keep answers up to date.', 'lib.reindexAll': 'Reindex all', 'lib.checkLinks': 'Check links',
  'lib.pendingOne': '1 import looks like a new version of an existing document.', 'lib.pendingMany': '{n} imports look like new versions of existing documents.',
  'lib.review': 'Review', 'lib.empty': 'No source yet.', 'lib.noMatch': 'No source matches this filter.',
  'lib.linkUrl': 'Page address', 'lib.linkPlaceholder': 'https://…', 'lib.add': 'Add', 'lib.cancel': 'Cancel',
  'lib.version': 'version {n}', 'lib.checked': 'checked on {date}',
  'state.ready': 'Up to date', 'state.indexing': 'Indexing…', 'state.error': 'Error', 'state.pending': 'Similar version detected',
  'state.changed': 'Changed — reindex', 'state.unreachable': 'Unreachable',
  'chunk.hierarchical': 'Hierarchical', 'chunk.semantic': 'Semantic', 'chunk.mixed': 'Mixed',
  'act.reindex': 'Reindex', 'act.remove': 'Delete', 'act.removeConfirm': 'Delete “{title}” from the library?', 'act.themes': 'Edit topics',
  'import.done': '{n} source(s) added, indexing in progress.', 'import.duplicates': 'Already present: {names}.', 'import.errors': 'Not imported: {names}.',
  'themes.title': 'Topics', 'themes.intro': 'Topics are suggested at indexing time; you can rename them, create new ones or reclassify a document.',
  'themes.new': 'New topic', 'themes.newSub': 'New subtopic', 'themes.tree': 'Topic tree', 'themes.unclassified': 'Unclassified', 'themes.all': 'All sources',
  'themes.count': '{n} sources', 'themes.ask': 'Query this topic', 'themes.rename': 'Rename', 'themes.delete': 'Delete topic', 'themes.name': 'Topic name',
  'themes.empty': 'No source in this topic.', 'themes.assign': 'Topics of “{title}”', 'themes.save': 'Save', 'themes.none': 'No topic yet.',
  'ver.eyebrow': 'Import awaiting your decision', 'ver.title': 'This document looks like a new version',
  'ver.intro': 'The imported file largely overlaps a document that is already indexed. Nothing is replaced without your consent.',
  'ver.existing': 'Already in the library', 'ver.imported': 'Imported file', 'ver.sections': '{n} sections', 'ver.indexed': 'indexed on {date}',
  'ver.covOld': 'of the old document is found in the new one', 'ver.covNew': 'of the new document already existed in the old one',
  'ver.verdict.revision': 'New version', 'ver.verdict.superset': 'Extended version', 'ver.verdict.subset': 'Excerpt', 'ver.verdict.overlap': 'Partial overlap',
  'ver.diag.revision': 'diagnosis: same document, revised', 'ver.diag.superset': 'diagnosis: the new one includes the old one and extends it',
  'ver.diag.subset': 'diagnosis: the new one is a part of the old one', 'ver.diag.overlap': 'diagnosis: the two documents partly overlap',
  'ver.compare': 'Section-by-section comparison', 'ver.colSection': 'Section', 'ver.colDiff': 'Difference', 'ver.colMerge': 'When merging',
  'ver.unchanged': 'Unchanged', 'ver.modified': 'Modified', 'ver.added': 'Added', 'ver.removed': 'Removed',
  'ver.kept': 'Kept', 'ver.keepNew': 'Keep the new one', 'ver.keepOld': 'Keep the old one', 'ver.drop': 'Remove', 'ver.keep': 'Keep', 'ver.add': 'Add', 'ver.skip': 'Do not add',
  'ver.choice': 'Choice for section “{title}”',
  'ver.note': 'When replaced, the old version is archived: it is no longer used to answer.',
  'ver.keepBoth': 'Keep both', 'ver.merge': 'Merge with my choices', 'ver.replace': 'Replace the old version', 'ver.discard': 'Cancel the import', 'ver.later': 'Decide later',
  'set.title': 'Settings', 'set.engine': 'Chat engine', 'set.local': 'Local Qwen model', 'set.localTag': 'free, built in',
  'set.localText': 'Everything is computed on this computer. No text leaves the machine.', 'set.claude': 'Claude', 'set.claudeTag': 'with your API key',
  'set.claudeText': 'The excerpts needed for the answer are sent to the API, with personal data masked. Indexing stays local.',
  'set.claudeKey': 'Claude API key', 'set.keyPlaceholder': 'Paste your API key', 'set.keySaved': 'A key is saved', 'set.save': 'Save', 'set.clear': 'Clear',
  'set.keyNote': 'The key is encrypted in the system keychain and is never displayed again.', 'set.claudeModel': 'Claude model', 'set.needKey': 'Save a key to enable this engine.',
  'set.models': 'Installed models', 'set.installed': 'Installed', 'set.missing': 'Not installed · {size} GB', 'set.downloading': 'Downloading… {pct}%', 'set.download': 'Download models',
  'set.links': 'Links and reindexing', 'set.check': 'Check links', 'set.checkText': 'The app compares the page with its last indexed version.',
  'set.daily': 'Every day', 'set.weekly': 'Every week', 'set.monthly': 'Every month', 'set.never': 'Never',
  'set.auto': 'Reindex without asking', 'set.autoText': 'Off: the app suggests, you decide.',
  'set.confluence': 'Confluence connection', 'set.optional': 'optional', 'set.confluenceText': 'Only needed for protected pages. Read-only access.',
  'set.confluenceUrl': 'Site address', 'set.confluenceUser': 'User name', 'set.confluenceToken': 'API token', 'set.tokenSaved': 'A token is saved',
  'set.general': 'General', 'set.language': 'Interface language', 'set.library': 'Library folder', 'set.change': 'Change…',
  'set.pii': 'Mask personal data', 'set.piiText': 'E-mails, phone numbers and identifiers are masked in answers and excerpts.',
  'setup.title': 'Installing the local models',
  'setup.text': 'The assistant runs on two free models executed on this computer. They are downloaded once (about 3.4 GB).',
  'setup.start': 'Download', 'setup.error': 'The download failed: {detail}', 'setup.retry': 'Retry',
  'common.close': 'Close', 'common.error': 'Something went wrong: {detail}',
};

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<'fr' | 'en'>('fr');

  t(key: string, params?: Record<string, string | number>): string {
    const dict = this.lang() === 'en' ? EN : FR;
    let text = (dict as Record<string, string>)[key] ?? key;
    if (params) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
    return text;
  }

  date(iso: string | null): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(this.lang() === 'en' ? 'en-GB' : 'fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  }
}

@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(key: string, params?: Record<string, string | number>): string {
    return this.i18n.t(key, params);
  }
}
