import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Api, type View } from './api';
import { ChatStore, ChatView } from './chat';
import { Icon } from './icon';
import { TPipe } from './i18n';
import { LibraryView } from './library';
import { SettingsView } from './settings';
import { ThemesView } from './themes';
import { VersionDialog } from './versions';

@Component({
  selector: 'app-root',
  imports: [ChatView, LibraryView, ThemesView, SettingsView, VersionDialog, Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
})
export class App {
  readonly api = inject(Api);
  readonly chat = inject(ChatStore);

  readonly items: { view: View; label: string }[] = [
    { view: 'chat', label: 'nav.chat' }, { view: 'library', label: 'nav.library' }, { view: 'themes', label: 'nav.themes' }, { view: 'settings', label: 'nav.settings' },
  ];
  readonly badge = computed(() => (this.api.status()?.linksToReindex ?? 0) + (this.api.status()?.pendingVersions ?? 0));
  readonly engine = computed(() => this.api.status()?.engineLabel ?? '');
  /** Premier lancement : le modèle de vectorisation (au minimum) doit être installé. */
  readonly setup = computed(() => {
    const status = this.api.status();
    return status && !status.ready ? status.models : null;
  });
  readonly downloading = computed(() => this.setup()?.some((m) => m.downloading) ?? false);
  readonly hasError = computed(() => this.setup()?.some((m) => m.error) ?? false);

  pct(value: number) { return Math.round(value * 100); }

  newConversation() { void this.chat.open(null); this.api.view.set('chat'); }
  openConversation(id: number) { void this.chat.open(id); this.api.view.set('chat'); }

  async download() {
    try { await this.api.call('models:download'); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }
}
