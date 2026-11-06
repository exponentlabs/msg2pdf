import {
  Check,
  Download,
  ExternalLink,
  FolderSearch,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import type { Workbench } from '../useWorkbench';

export function Settings({ workbench: w }: { workbench: Workbench }) {
  const [checking, setChecking] = useState(false);
  async function configure(action: 'chooseOffice' | 'detectOffice') {
    setChecking(true);
    try {
      await w.updateOffice(action);
    } finally {
      setChecking(false);
    }
  }
  const office = w.info?.office;
  return (
    <section className="settings-view">
      <div className="view-heading">
        <span className="eyebrow">MAKE YOURSELF AT HOME</span>
        <h1>Settings</h1>
        <p>A few things that help your workflow run smoothly.</p>
      </div>
      <section className="panel setup-panel">
        <div className="panel-heading">
          <div>
            <h2>Office conversion</h2>
            <p>Optional support for Word, Excel, and PowerPoint.</p>
          </div>
          <span className={`status-pill ${office?.available ? 'ready' : 'muted'}`}>
            {office?.available ? <Check size={13} /> : <Info size={13} />}
            {office?.available ? 'Connected' : 'Optional'}
          </span>
        </div>
        <div className="office-feature">
          <div className="office-mark">
            <FileOffice />
          </div>
          <div>
            <h3>Powered by LibreOffice</h3>
            <p>
              Keep the app lightweight. Connect an existing installation, or download the official
              installer when you need Office conversion.
            </p>
          </div>
        </div>
        {office?.executable && (
          <div className="path-detail">
            <span>APPLICATION</span>
            <code>{office.executable}</code>
            {office.version && <span>Version {office.version}</span>}
          </div>
        )}
        {office?.error && (
          <p className="inline-error" role="alert">
            {office.error}
          </p>
        )}
        <div className="setup-actions">
          <button
            type="button"
            className="button primary"
            disabled={checking || w.busy}
            onClick={() => void configure('chooseOffice')}
          >
            {checking ? <LoaderCircle className="spin" size={16} /> : <FolderSearch size={16} />}{' '}
            Locate LibreOffice
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => void w.attempt(() => window.desktop.downloadOffice())}
          >
            <Download size={16} /> Download installer <ExternalLink size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Detect LibreOffice again"
            disabled={checking || w.busy}
            onClick={() => void configure('detectOffice')}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <p className="fine-print">
          Download opens the official LibreOffice website. Once installed, use Locate LibreOffice or
          refresh detection. Stable version 26.2.6+ or 26.8.1+ is required.
        </p>
      </section>
      <div className="settings-grid">
        <section className="panel detail-panel">
          <ShieldCheck size={22} />
          <h2>Private by design</h2>
          <p>
            Files are processed on your computer. There is no upload service, account, analytics, or
            background update check.
          </p>
          <p>
            Recent activity stores file names, paths and counts locally. You can clear it at any
            time.
          </p>
        </section>
        <section className="panel detail-panel">
          <Terminal size={22} />
          <h2>Equally at home in a terminal</h2>
          <p>The GUI and CLI use the same conversion engine.</p>
          <code className="command-example">msg2pdf -i ./mail -o ./pdf --recursive</code>
          <p>
            See the included README for your platform's terminal launcher and packaging details.
          </p>
        </section>
      </div>
      <p className="version-line">
        msg2pdf {w.info?.version ?? '1.0.0'} · {w.info?.platform ?? 'Desktop'}{' '}
        <span>Project licensing pending owner review</span>
      </p>
    </section>
  );
}
function FileOffice() {
  return <span aria-hidden="true">lo</span>;
}
