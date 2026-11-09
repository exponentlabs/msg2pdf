import type { Blocker, Plan, ReviewPage, StudioState } from './studio-domain';

export type Matrix = [number, number, number, number, number, number];
export type Rectangle = [number, number, number, number];
export interface SnapshotPage {
  width: number;
  height: number;
  transform: Matrix;
  info: ReviewPage;
  png: string;
  referenceRgb: string;
  text: { text: string; rect: Rectangle }[];
}
export interface Snapshot {
  pages: SnapshotPage[];
  revisionHash: string;
  engine: string;
}
export interface StudioView {
  available: boolean;
  reason?: string | undefined;
  profile: string;
  case?:
    | {
        state: StudioState;
        label: string;
        names: Record<string, string>;
        blockers: Record<string, Blocker[]>;
      }
    | undefined;
}
export interface StudioApi {
  status(): Promise<StudioView>;
  create(): Promise<StudioView>;
  open(): Promise<StudioView>;
  close(): Promise<StudioView>;
  backup(): Promise<StudioView>;
  import(): Promise<StudioView>;
  prepare(request: { id: string; version: number }): Promise<StudioView>;
  snapshot(request: {
    id: string;
    revisionHash: string;
    snapshotHash: string;
  }): Promise<Omit<Snapshot, 'pages'> & { pages: Omit<SnapshotPage, 'referenceRgb'>[] }>;
  saveMarks(request: {
    id: string;
    version: number;
    revisionHash: string;
    marks: Plan['marks'];
  }): Promise<StudioView>;
  reviewPage(request: {
    id: string;
    version: number;
    revisionHash: string;
    page: number;
    decision: 'reviewed' | 'unreviewed';
  }): Promise<StudioView>;
  search(request: {
    id: string;
    revisionHash: string;
    phrase: string;
  }): Promise<{ page: number; rect: Rectangle; text: string }[]>;
  cancel(): Promise<void>;
  apply(request: { id: string; version: number }): Promise<StudioView>;
  reviewCandidate(request: {
    id: string;
    version: number;
    candidateHash: string;
    page: number;
  }): Promise<StudioView>;
  approveRelease(request: { version: number; selection: string[] }): Promise<StudioView>;
  publish(request: { version: number }): Promise<StudioView>;
}
