// Processus principal Electron : fenêtre verrouillée, IPC en liste blanche, planification des liens.
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './core/db.js';
import { Engine } from './core/engine.js';
import { ClaudeProvider, CLAUDE_MODELS, FakeChat, FakeEmbedder, LocalModels } from './core/llm.js';
import { resolveModelsDir } from './core/models-dir.js';
import { SUPPORTED_EXTENSIONS } from './core/parsers.js';
import { IPC_CHANNELS, type AppEvent, type AppStatus, type IpcChannel, type IpcContract } from '../shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = process.env['RAG_FAKE_LLM'] === '1';
if (process.env['RAG_DATA_DIR']) app.setPath('userData', process.env['RAG_DATA_DIR']);

const indexHtml = join(here, '..', 'dist', 'rag-assistant', 'browser', 'index.html');
const indexUrl = pathToFileURL(indexHtml).toString();
let win: BrowserWindow | null = null;

const emit = (event: AppEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send('app:event', event);
};

async function vecExtensionPath(): Promise<string | null> {
  try {
    const { getLoadablePath } = await import('sqlite-vec');
    return getLoadablePath().replace('app.asar', 'app.asar.unpacked');
  } catch {
    return null;
  }
}

async function boot() {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, 'assistant.sqlite'), await vecExtensionPath());
  const models = FAKE ? null : new LocalModels(resolveModelsDir(join(dataDir, 'models')), () => emit({ type: 'status' }));
  const fakeChat = new FakeChat();

  const engine = new Engine({
    store,
    embedder: models ?? new FakeEmbedder(),
    embedReady: () => (models ? models.embedReady : true),
    localChat: () => (models ? (models.chatReady ? models : null) : fakeChat),
    makeClaude: (key, model) => new ClaudeProvider(key, CLAUDE_MODELS.includes(model) ? model : CLAUDE_MODELS[0]),
    defaultLibraryDir: join(dataDir, 'library'),
    seal: (plain) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Le trousseau du système est indisponible : le secret n’a pas été enregistré.');
      return safeStorage.encryptString(plain).toString('base64');
    },
    unseal: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
    emit,
    groundThreshold: FAKE ? 0.15 : 0.45,
  });

  const status = (): AppStatus => {
    const list = models?.list() ?? [];
    const chat = engine.chat();
    return {
      models: list,
      ready: models ? models.embedReady && (models.chatReady || !!chat) : true,
      engineLabel: chat?.label ?? '',
      ...engine.counts(),
    };
  };

  const id = z.number().int().positive();
  const none = z.undefined().or(z.null());
  // Chaque canal a un schéma de validation et un gestionnaire ; rien d'autre n'est accessible à l'interface.
  const handlers: { [C in IpcChannel]: { schema: z.ZodType; run: (payload: any) => Promise<IpcContract[C][1]> | IpcContract[C][1] } } = {
    'app:status': { schema: none, run: () => status() },
    'models:download': { schema: none, run: () => { void models?.download(); } },
    'sources:list': { schema: none, run: () => engine.listSources() },
    'sources:pickFiles': {
      schema: none,
      run: async () => {
        const picked = await dialog.showOpenDialog(win!, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Documents', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) }],
        });
        return picked.canceled ? { imported: 0, duplicates: [], errors: [] } : engine.importPaths(picked.filePaths);
      },
    },
    'sources:importPaths': { schema: z.object({ paths: z.array(z.string().min(1).max(2000)).min(1).max(200) }), run: (p) => engine.importPaths(p.paths) },
    'sources:addLink': { schema: z.object({ url: z.string().min(8).max(2000) }), run: (p) => engine.addLink(p.url) },
    'sources:remove': { schema: z.object({ id }), run: (p) => engine.removeSource(p.id) },
    'sources:reindex': { schema: z.object({ id }), run: (p) => { void engine.reindex(p.id); } },
    'sources:setCategories': { schema: z.object({ id, categoryIds: z.array(id).max(20) }), run: (p) => engine.setCategories(p.id, p.categoryIds) },
    'links:check': { schema: none, run: () => engine.checkLinks(true) },
    'versions:pending': { schema: none, run: () => engine.pendingVersions() },
    'versions:decide': {
      schema: z.object({ id, action: z.enum(['replace', 'keep-both', 'merge', 'discard']), choices: z.record(z.string(), z.enum(['new', 'old', 'keep', 'drop'])).optional() }),
      run: (p) => engine.decide(p.id, p.action, p.choices),
    },
    'categories:tree': { schema: none, run: () => engine.categoryTree() },
    'categories:create': { schema: z.object({ name: z.string().min(1).max(40), parentId: id.nullable() }), run: (p) => { engine.createCategory(p.name, p.parentId); emit({ type: 'sources' }); } },
    'categories:rename': { schema: z.object({ id, name: z.string().min(1).max(40) }), run: (p) => engine.renameCategory(p.id, p.name) },
    'categories:remove': { schema: z.object({ id }), run: (p) => engine.removeCategory(p.id) },
    'chat:conversations': { schema: none, run: () => engine.conversations() },
    'chat:messages': { schema: z.object({ conversationId: id }), run: (p) => engine.messages(p.conversationId) },
    'chat:send': {
      schema: z.object({ conversationId: id.nullable(), text: z.string().min(1).max(4000), categoryId: id.nullable(), requestId: z.string().min(1).max(64) }),
      run: (p) => engine.send(p.conversationId, p.text, p.categoryId, p.requestId),
    },
    'chat:remove': { schema: z.object({ conversationId: id }), run: (p) => engine.removeConversation(p.conversationId) },
    'settings:get': { schema: none, run: () => engine.getSettings() },
    'settings:set': {
      schema: z.object({
        engine: z.enum(['local', 'claude']), claudeModel: z.enum(CLAUDE_MODELS as [string, ...string[]]), language: z.enum(['fr', 'en']),
        maskPii: z.boolean(), refreshDays: z.number().int().min(0).max(365), autoReindex: z.boolean(),
        confluenceBaseUrl: z.string().max(300), confluenceUser: z.string().max(200),
      }).partial().strict(),
      run: (p) => engine.setSettings(p),
    },
    'settings:setSecret': { schema: z.object({ name: z.enum(['claudeKey', 'confluenceToken']), value: z.string().max(500) }), run: (p) => engine.setSecret(p.name, p.value) },
    'settings:pickLibraryDir': {
      schema: none,
      run: async () => {
        const picked = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
        return picked.canceled ? engine.getSettings() : engine.setLibraryDir(picked.filePaths[0]);
      },
    },
  };

  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, payload) => {
      // Seule la page de l'application peut appeler l'IPC.
      if (event.senderFrame?.url.split(/[?#]/)[0] !== indexUrl) throw new Error('Appelant non autorisé');
      const handler = handlers[channel];
      const parsed = handler.schema.safeParse(payload);
      if (!parsed.success) throw new Error('Requête invalide');
      return handler.run(parsed.data);
    });
  }

  // Vérification périodique des liens : au démarrage, puis toutes les heures.
  const check = () => { void engine.checkLinks(false).catch(() => undefined); };
  setTimeout(check, 15_000);
  setInterval(check, 3_600_000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 720, minHeight: 560,
    title: 'Assistant RAG', backgroundColor: '#F5F6F8',
    show: process.env['RAG_HEADLESS'] !== '1',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools: !app.isPackaged, spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void win.loadFile(indexHtml);
}

app.enableSandbox();
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault(); });
});

void app.whenReady().then(async () => {
  // L'interface ne charge que ses propres fichiers : aucune requête réseau depuis la page.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:') || details.url.startsWith('blob:');
    callback({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await boot();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || process.env['RAG_DATA_DIR']) app.quit(); });
