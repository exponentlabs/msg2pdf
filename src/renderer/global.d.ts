import type { DesktopApi } from '../shared/contracts';
import type { StudioApi } from '../shared/studio';

declare global {
  interface Window {
    desktop: DesktopApi;
    studio: StudioApi;
  }
}
