import { EventEmitter } from 'node:events';

export class RealtimeHub {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(1000);
  }
  publish(organizationId, event) {
    this.emitter.emit(`org:${organizationId}`, { ...event, at: new Date().toISOString() });
  }
  subscribe(organizationId, listener) {
    const key = `org:${organizationId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
