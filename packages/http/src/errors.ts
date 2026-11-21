export class EgressDeniedError extends Error {
  readonly host: string;
  readonly reason: string;
  constructor(host: string, reason: string) {
    super(`egress denied to ${host}: ${reason}`);
    this.name = 'EgressDeniedError';
    this.host = host;
    this.reason = reason;
  }
}

export class ReplayMissError extends Error {
  readonly requestHash: string;
  constructor(requestHash: string, url: string) {
    super(`no recorded response for ${url} (${requestHash.slice(0, 12)})`);
    this.name = 'ReplayMissError';
    this.requestHash = requestHash;
  }
}
