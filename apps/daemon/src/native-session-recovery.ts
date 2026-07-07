import { createHash } from 'node:crypto';

import type {
  NativeSessionAcquisitionMode,
  NativeSessionContinuationMode,
  NativeSessionHandleKind,
  NativeSessionRecoveryHandle,
  NativeSessionRecoveryMetadata,
  NativeSessionRecoveryReason,
} from '@open-design/contracts';
import type { ResumeInvalidationReason } from './agent-session-resume.js';
import type { RuntimeAgentDef } from './runtimes/types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function handleKindForAgent(agentId: string | null): NativeSessionHandleKind {
  if (agentId === 'codex') return 'cli-thread-id';
  if (agentId === 'amr') return 'acp-session-handle';
  if (agentId === 'pi') return 'session-file-path';
  if (agentId) return 'opaque-id';
  return 'unknown';
}

export function redactNativeSessionHandle(input: {
  agentId: string | null;
  sessionId: string | null | undefined;
}): NativeSessionRecoveryHandle {
  const value = typeof input.sessionId === 'string' && input.sessionId.length > 0
    ? input.sessionId
    : null;
  return {
    present: value !== null,
    kind: handleKindForAgent(input.agentId),
    display: null,
    sha256: value ? sha256(value) : null,
    redacted: value !== null,
  };
}

function acquisitionForRuntime(
  def: Pick<RuntimeAgentDef, 'id' | 'resumesSessionViaCli' | 'capturesSessionIdFromStream' | 'resumesSessionViaAcpLoad'>,
  supported: boolean,
): NativeSessionAcquisitionMode {
  if (!supported) return 'none';
  if (def.resumesSessionViaAcpLoad === true) return 'acp-session-load';
  if (def.id === 'pi') return 'session-file-discovered';
  if (def.capturesSessionIdFromStream === true) return 'stream-captured';
  if (def.resumesSessionViaCli === true) return 'daemon-specified';
  return 'unknown';
}

function continuationForRuntime(
  def: Pick<RuntimeAgentDef, 'id' | 'resumesSessionViaCli' | 'resumesSessionViaAcpLoad'>,
  supported: boolean,
): NativeSessionContinuationMode {
  if (!supported) return 'none';
  if (def.resumesSessionViaAcpLoad === true) return 'acp-session-load';
  if (def.id === 'pi') return 'session-file-resume';
  if (def.resumesSessionViaCli === true) return 'native-resume-by-id';
  return 'unknown';
}

function guardReason(reason: ResumeInvalidationReason | null | undefined): NativeSessionRecoveryReason | null {
  return reason ?? null;
}

export function initialNativeSessionRecoveryMetadata(input: {
  agent: Pick<RuntimeAgentDef, 'id' | 'resumesSessionViaCli' | 'capturesSessionIdFromStream' | 'resumesSessionViaAcpLoad'>;
  supportsSessionResume: boolean;
  isResuming: boolean;
  resumeSessionId: string | null | undefined;
  invalidationReason: ResumeInvalidationReason | null | undefined;
  updatedAt?: number;
}): NativeSessionRecoveryMetadata {
  const now = input.updatedAt ?? Date.now();
  if (!input.supportsSessionResume) {
    return {
      agentId: input.agent.id,
      state: 'not_applicable',
      acquisition: 'none',
      continuation: 'none',
      handle: redactNativeSessionHandle({ agentId: input.agent.id, sessionId: null }),
      guardReason: 'unsupported',
      fallbackReason: null,
      updatedAt: now,
    };
  }
  const handle = redactNativeSessionHandle({
    agentId: input.agent.id,
    sessionId: input.resumeSessionId ?? null,
  });
  const state: NativeSessionRecoveryMetadata['state'] =
    input.isResuming && handle.present
      ? 'resume_attempted'
      : input.invalidationReason
        ? 'resume_skipped'
        : 'no_recoverable_session';
  return {
    agentId: input.agent.id,
    state,
    acquisition: acquisitionForRuntime(input.agent, input.supportsSessionResume),
    continuation: continuationForRuntime(input.agent, input.supportsSessionResume),
    handle,
    guardReason: state === 'resume_skipped' ? guardReason(input.invalidationReason) : null,
    fallbackReason: null,
    updatedAt: now,
  };
}

export function markNativeSessionCaptured(input: {
  previous: NativeSessionRecoveryMetadata | null | undefined;
  agentId: string | null;
  sessionId: string | null | undefined;
  resumed: boolean;
  updatedAt?: number;
}): NativeSessionRecoveryMetadata {
  const previous = input.previous ?? initialNativeSessionRecoveryMetadata({
    agent: { id: input.agentId ?? 'unknown' },
    supportsSessionResume: true,
    isResuming: false,
    resumeSessionId: null,
    invalidationReason: null,
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
  });
  const handle = redactNativeSessionHandle({ agentId: input.agentId, sessionId: input.sessionId });
  return {
    ...previous,
    state: handle.present
      ? (input.resumed ? 'resumed' : 'captured_not_resumed')
      : 'no_recoverable_session',
    handle,
    guardReason: null,
    fallbackReason: null,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function markNativeSessionAutoReseeded(input: {
  previous: NativeSessionRecoveryMetadata | null | undefined;
  agentId: string | null;
  previousSessionId: string | null | undefined;
  updatedAt?: number;
}): NativeSessionRecoveryMetadata {
  const previous = input.previous ?? initialNativeSessionRecoveryMetadata({
    agent: { id: input.agentId ?? 'unknown' },
    supportsSessionResume: true,
    isResuming: false,
    resumeSessionId: null,
    invalidationReason: null,
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
  });
  return {
    ...previous,
    state: 'auto_reseeded',
    handle: redactNativeSessionHandle({
      agentId: input.agentId,
      sessionId: input.previousSessionId,
    }),
    fallbackReason: 'resume_failed',
    updatedAt: input.updatedAt ?? Date.now(),
  };
}
