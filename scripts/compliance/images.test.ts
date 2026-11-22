import { describe, expect, it } from 'vitest';
import { checkImages, composeImages, dockerfileImages, splitImage, type ImageSpec } from './images.ts';
import type { LicencePolicy } from './policy.ts';

const policy: LicencePolicy = {
  allowed: ['MIT', 'PostgreSQL'],
  separateServiceOnly: ['GPL-*', 'AGPL-*'],
  deny: ['SSPL-1.0'],
};
const specs: Record<string, ImageSpec> = {
  postgres: { licence: 'PostgreSQL', purpose: 'db' },
  'gotenberg/gotenberg': { licence: 'MIT', purpose: 'pdf' },
  'acme/agpl-tool': { licence: 'AGPL-3.0-only', purpose: 'x' },
  'acme/agpl-service': { licence: 'AGPL-3.0-only', purpose: 'x', separateService: true },
  'acme/sspl-db': { licence: 'SSPL-1.0', purpose: 'x', separateService: true },
};

const use = (ref: string) => composeImages(`services:\n  s:\n    image: ${ref}\n`, 'compose.yml');

describe('image licence check', () => {
  it('parses compose files and Dockerfiles (stage references are not images)', () => {
    const compose = composeImages(
      'services:\n  db:\n    image: postgres:19.0-alpine\n  app:\n    build: .\n',
      'compose.yml',
    );
    expect(compose).toMatchObject([{ repository: 'postgres', tag: '19.0-alpine', where: 'db' }]);
    const docker = dockerfileImages(
      'FROM ghcr.io/astral-sh/uv:0.1 AS uv\nFROM python:3.15\nCOPY --from=uv /uv /bin/uv\nFROM uv AS again\nFROM scratch\n',
      'svc/Dockerfile',
    );
    expect(docker.map((d) => d.repository)).toEqual(['ghcr.io/astral-sh/uv', 'python']);
    expect(splitImage('registry:5000/ns/img:1.0@sha256:abc')).toEqual({
      repository: 'registry:5000/ns/img',
      tag: '1.0',
    });
  });

  it('allows listed images with allowed licences', () => {
    const findings = checkImages([...use('postgres:19'), ...use('gotenberg/gotenberg:9')], specs, policy);
    expect(findings.every((f) => f.decision.verdict === 'allow')).toBe(true);
  });

  it('fails an image missing from the components file', () => {
    const [finding] = checkImages(use('unknown/thing:1'), specs, policy);
    expect(finding?.decision).toEqual({ verdict: 'review', rule: 'not-in-components.yaml' });
  });

  it('fails an AGPL image without separateService and passes it with the flag', () => {
    expect(checkImages(use('acme/agpl-tool:1'), specs, policy)[0]?.decision.verdict).toBe('deny');
    expect(checkImages(use('acme/agpl-service:1'), specs, policy)[0]?.decision.verdict).toBe('allow');
  });

  it('never waives a denied licence with the separateService flag', () => {
    expect(checkImages(use('acme/sspl-db:1'), specs, policy)[0]?.decision.verdict).toBe('deny');
  });
});
