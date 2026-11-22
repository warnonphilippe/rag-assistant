// Types partagés entre le processus principal (Electron) et l'interface (Angular).

export type SourceKind = 'file' | 'link';
export type SourceStatus = 'indexing' | 'ready' | 'pending' | 'archived' | 'error';
export type ChunkingMode = 'hierarchical' | 'semantic' | 'mixed';
export type LinkState = 'ok' | 'changed' | 'unreachable' | null;

export interface SourceDoc {
  id: number;
  kind: SourceKind;
  title: string;
  format: string;
  url: string | null;
  status: SourceStatus;
  chunking: ChunkingMode | null;
  version: number;
  summary: string;
  indexedAt: string | null;
  lastCheckedAt: string | null;
  linkState: LinkState;
  refreshDays: number;
  error: string | null;
  categories: { id: number; name: string }[];
  progress?: number;
}

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
  count: number;
  children: CategoryNode[];
}

export type VersionVerdict = 'revision' | 'superset' | 'subset' | 'overlap';
export type SectionDiff = 'unchanged' | 'modified' | 'added' | 'removed';

export interface SectionComparison {
  title: string;
  diff: SectionDiff;
  newSectionId: number | null;
  oldSectionId: number | null;
}

export interface PendingVersion {
  id: number;
  newDoc: { id: number; title: string; format: string; sections: number };
  oldDoc: { id: number; title: string; format: string; sections: number; indexedAt: string | null };
  coverageOld: number; // part de l'ancien document retrouvée dans le nouveau (0..1)
  coverageNew: number; // part du nouveau document déjà présente dans l'ancien (0..1)
  verdict: VersionVerdict;
  sections: SectionComparison[];
}

export type VersionAction = 'replace' | 'keep-both' | 'merge' | 'discard';
/** Pour une fusion : clé = index de section dans le rapport, valeur = 'new' | 'old' | 'keep' | 'drop'. */
export type MergeChoices = Record<number, 'new' | 'old' | 'keep' | 'drop'>;

export interface Citation {
  n: number;
  docId: number;
  docTitle: string;
  format: string;
  kind: SourceKind;
  section: string;
  excerpt: string;
}

export interface DocHit {
  docId: number;
  title: string;
  kind: SourceKind;
  format: string;
  excerpt: string;
  section: string;
  categories: string[];
}

export type AnswerKind = 'grounded' | 'documents' | 'model' | 'refused' | 'empty';

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: 'user' | 'assistant';
  content: string;
  kind: AnswerKind | null;
  citations: Citation[];
  documents: DocHit[];
  engine: string | null;
  createdAt: string;
}

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
}

export type EngineChoice = 'local' | 'claude';

export interface AppSettings {
  engine: EngineChoice;
  claudeModel: string;
  hasClaudeKey: boolean;
  language: 'fr' | 'en';
  maskPii: boolean;
  refreshDays: number; // 0 = jamais
  autoReindex: boolean;
  libraryDir: string;
  confluenceBaseUrl: string;
  confluenceUser: string;
  hasConfluenceToken: boolean;
}

export interface ModelState {
  id: 'chat' | 'embed';
  label: string;
  installed: boolean;
  downloading: boolean;
  progress: number; // 0..1
  sizeGb: number;
  error: string | null;
}

export interface AppStatus {
  models: ModelState[];
  ready: boolean;
  engineLabel: string;
  sources: { total: number; files: number; links: number };
  linksToReindex: number;
  pendingVersions: number;
}

export type AppEvent =
  | { type: 'status' }
  | { type: 'sources' }
  | { type: 'token'; requestId: string; text: string }
  | { type: 'notice'; level: 'info' | 'error'; key: string; detail?: string };

export interface ImportResult {
  imported: number;
  duplicates: string[];
  errors: { name: string; message: string }[];
}

/** Contrat IPC : nom du canal -> [paramètre, résultat]. Seuls ces canaux sont exposés. */
export interface IpcContract {
  'app:status': [void, AppStatus];
  'models:download': [void, void];
  'sources:list': [void, SourceDoc[]];
  'sources:pickFiles': [void, ImportResult];
  'sources:importPaths': [{ paths: string[] }, ImportResult];
  'sources:addLink': [{ url: string }, ImportResult];
  'sources:remove': [{ id: number }, void];
  'sources:reindex': [{ id: number }, void];
  'sources:setCategories': [{ id: number; categoryIds: number[] }, void];
  'links:check': [void, void];
  'versions:pending': [void, PendingVersion[]];
  'versions:decide': [{ id: number; action: VersionAction; choices?: MergeChoices }, void];
  'categories:tree': [void, CategoryNode[]];
  'categories:create': [{ name: string; parentId: number | null }, void];
  'categories:rename': [{ id: number; name: string }, void];
  'categories:remove': [{ id: number }, void];
  'chat:conversations': [void, Conversation[]];
  'chat:messages': [{ conversationId: number }, ChatMessage[]];
  'chat:send': [{ conversationId: number | null; text: string; categoryId: number | null; requestId: string }, { conversationId: number; message: ChatMessage }];
  'chat:remove': [{ conversationId: number }, void];
  'settings:get': [void, AppSettings];
  'settings:set': [Partial<Pick<AppSettings, 'engine' | 'claudeModel' | 'language' | 'maskPii' | 'refreshDays' | 'autoReindex' | 'confluenceBaseUrl' | 'confluenceUser'>>, AppSettings];
  'settings:setSecret': [{ name: 'claudeKey' | 'confluenceToken'; value: string }, AppSettings];
  'settings:pickLibraryDir': [void, AppSettings];
}

export type IpcChannel = keyof IpcContract;

export const IPC_CHANNELS: IpcChannel[] = [
  'app:status', 'models:download',
  'sources:list', 'sources:pickFiles', 'sources:importPaths', 'sources:addLink', 'sources:remove', 'sources:reindex', 'sources:setCategories',
  'links:check', 'versions:pending', 'versions:decide',
  'categories:tree', 'categories:create', 'categories:rename', 'categories:remove',
  'chat:conversations', 'chat:messages', 'chat:send', 'chat:remove',
  'settings:get', 'settings:set', 'settings:setSecret', 'settings:pickLibraryDir',
];

export interface RendererApi {
  invoke<C extends IpcChannel>(channel: C, payload?: IpcContract[C][0]): Promise<IpcContract[C][1]>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  pathForFile(file: File): string;
}
