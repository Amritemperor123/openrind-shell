import type { ZodType } from 'zod';
export type ProviderKind = 'local-chromium' | 'browserbase' | 'desktop-webview';
export type ProfileMode = 'ephemeral' | 'host-retained' | 'provider-context';
export interface BrowserPrincipal { tenantId: string; workspaceId: string; sandboxId: string; conversationId: string; grantId: string; expiresAt: number }
export interface BrowserCapabilities {
  protocol: 1; provider: ProviderKind; driver: 'playwright' | 'electron-debugger'; browserVersion: string;
  navigation: boolean; semanticSnapshot: boolean; elementActions: boolean; crossOriginFrames: boolean;
  screenshots: boolean; fileUpload: boolean; fileDownload: boolean; managedPopups: boolean; backgroundAutomation: boolean;
  manualControl: 'local-window' | 'provider-viewer' | 'sidebar' | 'none'; profiles: ProfileMode;
  reconnect: 'existing-session' | 'new-session-only'; networkEnforcement: 'application-guardrails' | 'enforced-backend-policy';
}
export interface OperationContext { principal: BrowserPrincipal; sessionId: string; sessionEpoch: number; operationId?: string; deadline: number; signal: AbortSignal }
export interface ValidatedUrl { readonly href: string; readonly origin: string }
export interface ApprovedSessionSpec { readonly provider: ProviderKind; readonly profileMode: ProfileMode; readonly profileId?: string; readonly initialUrl?: ValidatedUrl; readonly allowedOrigins: readonly string[]; readonly networkEnforcement: BrowserCapabilities['networkEnforcement'] }
export interface PageDescriptor { pageId: string; documentGeneration: number; url?: string }
export interface ResolvedNode { readonly handle: unknown; readonly frameId: string; readonly documentGeneration: number }
export type ResolvedPageAction =
  | { kind: 'click'; target: ResolvedNode }
  | { kind: 'fill'; target: ResolvedNode; text: string }
  | { kind: 'select'; target: ResolvedNode; values: string[] }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; distance: number };
export interface SnapshotOptions { depth: number; maxNodes: number; maxTextBytes: number }
export interface RawSnapshotNode { kind: 'element' | 'text' | 'frame-boundary'; frameId: string; handle?: unknown; role?: string; name?: string; text?: string; sensitive?: boolean; editable?: boolean; checked?: boolean; disabled?: boolean; children?: RawSnapshotNode[] }
export interface RawSnapshot { documentGeneration: number; nodes: RawSnapshotNode[] }
export interface ArtifactSource { bytes: AsyncIterable<Uint8Array>; mimeType: string; expectedBytes?: number }
export interface ApprovedUpload { artifactId: string; bytes: AsyncIterable<Uint8Array>; size: number; sha256: string; mimeType: string }
export interface PageDriver {
  readonly pageId: string;
  navigate(url: ValidatedUrl, context: OperationContext): Promise<{ url: string; documentGeneration: number }>;
  snapshot(options: SnapshotOptions, context: OperationContext): Promise<RawSnapshot>;
  act(action: ResolvedPageAction, context: OperationContext): Promise<void>;
  screenshot(options: { region?: { x: number; y: number; width: number; height: number } }, context: OperationContext): Promise<ArtifactSource>;
  attachUpload(target: ResolvedNode, upload: ApprovedUpload, context: OperationContext): Promise<void>;
  close(context: OperationContext): Promise<void>;
}
export interface ProviderSession {
  readonly handle: string; readonly capabilities: BrowserCapabilities;
  pages(): Promise<PageDescriptor[]>;
  openPage(url: ValidatedUrl, context: OperationContext): Promise<PageDescriptor>;
  page(pageId: string): PageDriver;
  setHumanControl(active: boolean, context: OperationContext): Promise<void>;
}
export interface RecoverableSessionRecord { sessionId: string; sessionEpoch: number; handle: string }
export interface BrowserProvider {
  readonly kind: ProviderKind; readonly capabilities: BrowserCapabilities;
  create(spec: ApprovedSessionSpec, context: OperationContext): Promise<ProviderSession>;
  recover(record: RecoverableSessionRecord, context: OperationContext): Promise<ProviderSession | { lost: true; reason: string }>;
  close(session: ProviderSession, reason: 'requested' | 'revoked' | 'shutdown'): Promise<{ closed: boolean }>;
}
export type BrowserToolResult<T> = { ok: true; sessionId?: string; sessionEpoch?: number; operationId?: string; data: T; warnings: string[] } |
  { ok: false; code: string; message: string; operationId?: string; outcome: 'not-started' | 'completed' | 'unknown'; retry: 'safe' | 'inspect-first' | 'never' };
export const PROTOCOL_VERSION: 1;
export const LIMITS: Readonly<Record<string, number>>;
export const ProviderKind: ZodType<ProviderKind>;
export const Principal: ZodType<BrowserPrincipal>;
export const Capabilities: ZodType<BrowserCapabilities>;
export const Url: ZodType<string>;
export const WorkspacePath: ZodType<string>;
export const id: ZodType<string>;
export const ToolSchemas: Readonly<Record<string, ZodType>>;
export const PrivateRequest: ZodType;
export const REMOTE_TOOLS: readonly string[];
export const LOCAL_TOOLS: readonly string[];
export const ERROR_MESSAGES: Readonly<Record<string, string>>;
export class BrowserFault extends Error { code: string; outcome: string; constructor(code: string, outcome?: 'not-started' | 'completed' | 'unknown') }
export function parseTool(name: string, input: unknown, options?: { local?: boolean }): Record<string, unknown>;
export function toolDefinitions(options?: { local?: boolean }): { name: string; description: string; inputSchema: unknown }[];
export function failure(error: unknown, operationId?: string): BrowserToolResult<never>;
