import * as stub from './stub.js';
import * as stubPw from './stub-pw.js';
import * as progressive from './progressive.js';
import * as lemonade from './lemonade.js';
import * as petsbest from './petsbest.js';
import * as erenterplan from './erenterplan.js';

const REGISTRY = {
  stub,
  'stub-pw': stubPw,
  progressive,
  lemonade,
  petsbest,
  erenterplan,
};

export function getCarrier(name) {
  return REGISTRY[name] || null;
}

export function listCarriers() {
  return [
    { id: 'lemonade',    name: 'Lemonade' },
    { id: 'petsbest',    name: 'Pets Best' },
    { id: 'erenterplan', name: 'eRenterPlan', experimental: true },
    { id: 'progressive', name: 'Progressive', experimental: true },
    { id: 'stub-pw',     name: 'Stub (Playwright via fake portal)' },
    { id: 'stub',        name: 'Stub (in-memory, no browser)' },
    { id: 'allstate',    name: 'Allstate', disabled: true },
    { id: 'geico',       name: 'Geico', disabled: true },
  ];
}
