// Pont minimal entre l'interface (isolée, sans Node) et le processus principal.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, type AppEvent, type RendererApi } from '../shared/types';

const allowed = new Set<string>(IPC_CHANNELS);

const api: RendererApi = {
  invoke(channel, payload) {
    if (!allowed.has(channel)) return Promise.reject(new Error('Canal non autorisé'));
    return ipcRenderer.invoke(channel, payload);
  },
  onEvent(listener) {
    const wrapped = (_event: unknown, data: AppEvent) => listener(data);
    ipcRenderer.on('app:event', wrapped);
    return () => ipcRenderer.removeListener('app:event', wrapped);
  },
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('api', api);
