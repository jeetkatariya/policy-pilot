import * as stub from './stub.js';
import * as stubPw from './stub-pw.js';
import * as progressive from './progressive.js';
import * as lemonade from './lemonade.js';

const REGISTRY = {
  stub,
  'stub-pw': stubPw,
  progressive,
  lemonade,
};

export function getCarrier(name) {
  return REGISTRY[name] || null;
}

export function listCarriers() {
  return [
    { id: 'progressive', name: 'Progressive', experimental: true },
    { id: 'lemonade',    name: 'Lemonade',    experimental: true },
    { id: 'stub-pw',     name: 'Stub (Playwright via fake portal)' },
    { id: 'stub',        name: 'Stub (in-memory, no browser)' },
    { id: 'allstate',    name: 'Allstate',    disabled: true },
    { id: 'geico',       name: 'Geico',       disabled: true },
  ];
}
