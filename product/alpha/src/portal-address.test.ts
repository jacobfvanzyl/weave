import { describe, expect, it } from 'vitest';
import { portalHostName, portalWebSocketUrl } from './portal-address';

describe('Portal address', () => {
  it.each([
    ['127.0.0.1', 'ws://127.0.0.1:4122/rpc'],
    ['localhost', 'ws://localhost:4122/rpc'],
    ['bazzite', 'wss://bazzite:4122/rpc'],
    ['bazzite:5000', 'wss://bazzite:5000/rpc'],
    ['jacos-macbook-air-1.tail4228ce.ts.net', 'wss://jacos-macbook-air-1.tail4228ce.ts.net:4122/rpc'],
    ['ws://bazzite', 'ws://bazzite:4122/rpc'],
    ['http://bazzite', 'ws://bazzite:4122/rpc'],
    ['https://portal.example.test', 'wss://portal.example.test:4122/rpc'],
    ['wss://portal.example.test:8443/custom?ignored=true', 'wss://portal.example.test:8443/rpc'],
  ])('normalizes %s for the Portal transport', (address, expected) => {
    expect(portalWebSocketUrl(address).toString()).toBe(expected);
  });

  it('derives the host label from a scheme-free address', () => {
    expect(portalHostName('bazzite')).toBe('bazzite');
  });

  it.each(['', 'ftp://bazzite'])('rejects an invalid Portal address: %s', (address) => {
    expect(() => portalWebSocketUrl(address)).toThrow();
  });
});
