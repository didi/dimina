import { systemDateTime } from '@kit.BasicServicesKit';
import { DiagnosticWorkerEvent } from '../Service/DMPSendableObjects';

interface DiagnosticVersions {
  host?: string;
  sdk?: string;
  jssdk?: string;
  compiler?: string;
}

interface DiagnosticEvent {
  sequence: number;
  elapsedMs: number;
  phase: string;
  appId: string;
  pagePath?: string;
  bridgeId?: string;
  resourceLoadId?: string;
  failure?: string;
  callId?: string;
  api?: string;
  outcome?: string;
}

interface DiagnosticReport {
  schemaVersion: number;
  platform: string;
  versions: DiagnosticVersions;
  events: DiagnosticEvent[];
}

export interface DiagnosticCall {
  generation: number;
  id: string;
  api: string;
  appId: string;
  pagePath?: string;
  bridgeId?: string;
}

export class DMPRuntimeDiagnostics {
  private static readonly eventLimit = 200;
  private static readonly launchEvents: DiagnosticEvent[] = [];
  private static readonly bridgeEvents: DiagnosticEvent[] = [];
  private static enabled = false;
  private static versions: DiagnosticVersions = {};
  private static startedAt = 0;
  private static generation = 0;
  private static sequence = 0;

  static configure(enabled: boolean, host?: string, sdk?: string, jssdk?: string, compiler?: string): void {
    DMPRuntimeDiagnostics.enabled = enabled;
    DMPRuntimeDiagnostics.versions = { host, sdk, jssdk, compiler };
    DMPRuntimeDiagnostics.startedAt = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
    DMPRuntimeDiagnostics.generation++;
    DMPRuntimeDiagnostics.launchEvents.length = 0;
    DMPRuntimeDiagnostics.bridgeEvents.length = 0;
  }

  static get captureGeneration(): number | undefined {
    return DMPRuntimeDiagnostics.enabled ? DMPRuntimeDiagnostics.generation : undefined;
  }

  static launch(phase: string, appId: string, pagePath?: string, bridgeId?: string,
    resourceLoadId?: string, failure?: string): void {
    if (!DMPRuntimeDiagnostics.enabled) return;
    const event = DMPRuntimeDiagnostics.event(phase, appId, pagePath, bridgeId);
    event.resourceLoadId = resourceLoadId;
    event.failure = failure;
    DMPRuntimeDiagnostics.append(DMPRuntimeDiagnostics.launchEvents, event);
  }

  static beginCall(api: string, appId: string, pagePath?: string, bridgeId?: string): DiagnosticCall | undefined {
    if (!DMPRuntimeDiagnostics.enabled) return undefined;
    const call: DiagnosticCall = {
      generation: DMPRuntimeDiagnostics.generation, id: `call-${DMPRuntimeDiagnostics.sequence + 1}`, api, appId, pagePath, bridgeId
    };
    DMPRuntimeDiagnostics.recordCall(call, 'api-received');
    return call;
  }

  static recordCall(call: DiagnosticCall | undefined, phase: string, outcome?: string): void {
    if (!call || !DMPRuntimeDiagnostics.enabled || call.generation !== DMPRuntimeDiagnostics.generation) return;
    const event = DMPRuntimeDiagnostics.event(phase, call.appId, call.pagePath, call.bridgeId);
    event.callId = call.id;
    event.api = call.api;
    event.outcome = outcome;
    DMPRuntimeDiagnostics.append(DMPRuntimeDiagnostics.bridgeEvents, event);
  }

  static recordWorkerEvent(workerEvent: DiagnosticWorkerEvent, appId: string, pagePath?: string): void {
    if (!DMPRuntimeDiagnostics.enabled || workerEvent.generation !== DMPRuntimeDiagnostics.generation) return;
    const event = DMPRuntimeDiagnostics.event(workerEvent.phase, appId, pagePath, workerEvent.bridgeId);
    event.elapsedMs = workerEvent.timestamp - DMPRuntimeDiagnostics.startedAt;
    event.callId = workerEvent.id;
    event.api = workerEvent.api;
    event.outcome = workerEvent.outcome;
    DMPRuntimeDiagnostics.append(DMPRuntimeDiagnostics.bridgeEvents, event);
  }

  static json(): string | undefined {
    if (!DMPRuntimeDiagnostics.enabled) return undefined;
    const report: DiagnosticReport = {
      schemaVersion: 1,
      platform: 'Harmony',
      versions: DMPRuntimeDiagnostics.versions,
      events: DMPRuntimeDiagnostics.launchEvents.concat(DMPRuntimeDiagnostics.bridgeEvents).sort((a, b) => a.elapsedMs - b.elapsedMs || a.sequence - b.sequence)
    };
    return JSON.stringify(report);
  }

  private static event(phase: string, appId: string, pagePath?: string, bridgeId?: string): DiagnosticEvent {
    return {
      sequence: ++DMPRuntimeDiagnostics.sequence,
      elapsedMs: systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false) - DMPRuntimeDiagnostics.startedAt,
      phase, appId, pagePath: pagePath?.split(/[?#]/, 1)[0], bridgeId
    };
  }

  private static append(events: DiagnosticEvent[], event: DiagnosticEvent): void {
    if (events.length === DMPRuntimeDiagnostics.eventLimit) events.shift();
    events.push(event);
  }
}
