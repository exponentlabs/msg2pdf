import {
  ArrowRightLeft,
  ChevronRight,
  CircleAlert,
  FileStack,
  History,
  LockKeyhole,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Activity } from './components/Activity';
import { PreviewDialog } from './components/PreviewDialog';
import { Settings } from './components/Settings';
import { Studio } from './components/Studio';
import { Workbench } from './components/Workbench';
import { useWorkbench } from './useWorkbench';

export function App() {
  const w = useWorkbench();
  const [view, setView] = useState<'convert' | 'activity' | 'settings' | 'studio'>('convert');
  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || w.busy) return;
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        setView('convert');
        void w.choose(event.shiftKey ? 'directory' : 'files');
      }
      if (event.key === 'Enter' && view === 'convert') {
        event.preventDefault();
        void w.convert();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [w.busy, w.choose, w.convert, view]);
  const navigation = [
    { id: 'convert', label: 'Converter', icon: ArrowRightLeft },
    { id: 'activity', label: 'Recent activity', icon: History },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
    { id: 'studio', label: 'Redaction studio', icon: ShieldCheck },
  ] as const;
  return (
    <div className={`app-shell ${w.info?.platform === 'darwin' ? 'platform-mac' : ''}`}>
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-mark">
            <FileStack size={22} strokeWidth={1.7} />
          </span>
          <span>
            msg2pdf<span className="brand-period">.</span>
          </span>
        </div>
        <div className="sidebar-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-label={label}
              className={`nav-item ${view === id ? 'active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'activity' && w.history.length > 0 && (
                <span className="nav-count">{w.history.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span className="privacy-icon">
              <LockKeyhole size={17} />
            </span>
            <h3>A little peace of mind.</h3>
            <p>
              Your files stay on your device.
              <br />
              Always.
            </p>
            <span>
              <span className="privacy-dot" /> Local processing
            </span>
          </div>
          <div className="sidebar-version">
            DESKTOP EDITION<span>v{w.info?.version ?? '1.0.0'}</span>
          </div>
        </div>
      </aside>
      <main className="app-main">
        <header className="workspace-header">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <span>
              {view === 'convert'
                ? 'Converter'
                : view === 'activity'
                  ? 'Recent activity'
                  : view === 'studio'
                    ? 'Redaction studio'
                    : 'Settings'}
            </span>
          </div>
          <span className="local-badge">
            <ShieldCheck size={14} /> Private & offline
          </span>
        </header>
        {w.error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={18} />
            <span>{w.error}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss error"
              onClick={w.clearError}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {view === 'studio' ? (
          <Studio />
        ) : view === 'convert' ? (
          <Workbench workbench={w} openSettings={() => setView('settings')} />
        ) : (
          <div className="page-body">
            {view === 'settings' ? <Settings workbench={w} /> : <Activity workbench={w} />}
          </div>
        )}
      </main>
      {w.preview && <PreviewDialog preview={w.preview} onClose={w.closePreview} />}
      {w.previewing && (
        <div className="preview-loading" role="status">
          Preparing a safe preview…
        </div>
      )}
    </div>
  );
}
